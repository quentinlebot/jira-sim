// The simulator's state in PostgreSQL: one table per entity, one write per operation, atomic counters, real transactions.
// Only the CLI loads this file (`--postgres <uri>` or POSTGRES_URI): nothing else in this repo needs the pg driver.
//
//   projects     (id, key unique, name)
//   metadata     (id, doc jsonb)                    'workflow' | 'settings' | 'instance'
//                'instance' is written last: no row, no state, and an empty database is seeded again
//   users        (account_id, seq, display_name, email_address)
//   issues       (id, seq, project, key unique, type, summary, description jsonb, description_text,
//                 labels jsonb, status, resolution, resolution_date, parent, assignee, reporter,
//                 created, updated, custom jsonb)
//   comments     (id, seq, issue_id, author, body jsonb, body_text, created, updated)
//   worklogs     (id, seq, issue_id, author, time_spent, time_spent_seconds, started, created)
//   changelog    (issue_id, at, author, field, prev, next)   prev and next: "from" and "to" are reserved words
//   links        (id, seq, type, inward, outward)           unique type+inward+outward
//   faults       (id, seq, label, method, path, kind, status, message, delay_ms, remaining, hits)
//   counters     (id, seq)                                seq is the last value handed out
//   request_log  (n, at, method, path, status, ms, user_email, fault, error, request jsonb, response jsonb)
//
// seq is the numeric id, so rows sort in creation order like the arrays of the JSON state.
import { Pool } from 'pg';
import { DEFAULT_PROJECT, seedState } from './seed';
import { IssueQuery, LOG_SIZE, LogBodies, SimContext, SimStorage } from './storage';
import {
  DEFAULT_SETTINGS, IssueCore, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink, SimSettings, SimState, SimUser, SimWorklog
} from './types';

export const DEFAULT_DB = 'devfactory-sim';

/** A Pool, or one client of it inside a transaction: what the shared inserts run on. */
interface QueryRunner {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, any>[]; rowCount: number | null }>;
}

type IssueRow = {
  id: string; seq: number; project: string; key: string; type: string; summary: string;
  description: unknown | null; description_text: string | null; labels: string[] | null; status: string;
  resolution: string | null; resolution_date: string | null; parent: string | null; assignee: string | null;
  reporter: string; created: string; updated: string; custom: Record<string, unknown> | null;
};

/** The documents of `metadata`, told apart by their id. */
type WorkflowDoc = Pick<SimState, 'statuses' | 'issueTypes' | 'resolutions' | 'linkTypes'>;
type InstanceDoc = { version: 1; me: string; project: string; writtenAt: string };

/** The database named in the URI's path, e.g. postgres://127.0.0.1:5432/devfactory-sim. */
export function dbNameOf(uri: string): string | undefined {
  const m = /^postgres(?:ql)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** The URI without its credentials, for logs and the dashboard. */
export function redactUri(uri: string): string {
  return uri.replace(/^(postgres(?:ql)?:\/\/)[^@/]+@/, '$1***@');
}

/** jsonb parameters go as JSON text: pg would write a JS array as an array literal, which is not JSON. */
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

const camelToSnake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The issue columns whose values are jsonb, so go through `json`. */
const JSONB_COLUMNS = new Set(['description', 'description_text', 'labels', 'custom']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id text PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE IF NOT EXISTS metadata (id text PRIMARY KEY, doc jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS users (account_id text PRIMARY KEY, seq integer NOT NULL, display_name text NOT NULL, email_address text NOT NULL);
CREATE TABLE IF NOT EXISTS issues (
  id text PRIMARY KEY, seq integer NOT NULL, project text NOT NULL, key text NOT NULL UNIQUE, type text NOT NULL,
  summary text NOT NULL, description jsonb, description_text text, labels jsonb NOT NULL DEFAULT '[]', status text NOT NULL,
  resolution text, resolution_date text, parent text, assignee text, reporter text NOT NULL,
  created text NOT NULL, updated text NOT NULL, custom jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS issues_project_seq ON issues (project, seq);
CREATE INDEX IF NOT EXISTS issues_parent ON issues (parent);
CREATE TABLE IF NOT EXISTS comments (
  id text PRIMARY KEY, seq integer NOT NULL, issue_id text NOT NULL, author text NOT NULL,
  body jsonb NOT NULL, body_text text NOT NULL, created text NOT NULL, updated text NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue ON comments (issue_id, seq);
CREATE TABLE IF NOT EXISTS worklogs (
  id text PRIMARY KEY, seq integer NOT NULL, issue_id text NOT NULL, author text NOT NULL,
  time_spent text NOT NULL, time_spent_seconds integer NOT NULL, started text NOT NULL, created text NOT NULL
);
CREATE INDEX IF NOT EXISTS worklogs_issue ON worklogs (issue_id, seq);
CREATE TABLE IF NOT EXISTS changelog (
  issue_id text NOT NULL, at text NOT NULL, author text NOT NULL, field text NOT NULL, prev text, next text,
  seq bigserial NOT NULL
);
CREATE INDEX IF NOT EXISTS changelog_issue ON changelog (issue_id, at);
CREATE TABLE IF NOT EXISTS links (
  id text PRIMARY KEY, seq integer NOT NULL, type text NOT NULL, inward text NOT NULL, outward text NOT NULL,
  UNIQUE (type, inward, outward)
);
CREATE INDEX IF NOT EXISTS links_inward ON links (inward);
CREATE INDEX IF NOT EXISTS links_outward ON links (outward);
CREATE TABLE IF NOT EXISTS faults (
  id text PRIMARY KEY, seq integer NOT NULL, label text NOT NULL, method text NOT NULL, path text NOT NULL,
  kind text NOT NULL, status integer NOT NULL, message text NOT NULL, delay_ms integer NOT NULL,
  remaining integer NOT NULL, hits integer NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (id text PRIMARY KEY, seq integer NOT NULL);
CREATE TABLE IF NOT EXISTS request_log (
  n integer PRIMARY KEY, at text NOT NULL, method text NOT NULL, path text NOT NULL, status integer NOT NULL,
  ms integer NOT NULL, user_email text, fault text, error text, request jsonb, response jsonb
);`;

export class PostgresStorage implements SimStorage {
  readonly kind = 'postgres';
  readonly location: string;
  private readonly pool: Pool;
  private readonly dbName: string;
  /** The project the issues are read from; set when the state is opened or replaced. */
  private projectKey = '';
  private seeding?: Promise<void>;

  constructor(uri: string, private readonly project: string = DEFAULT_PROJECT) {
    this.dbName = dbNameOf(uri) ?? DEFAULT_DB;
    const where = redactUri(uri).replace(/\?.*$/, '');
    this.location = dbNameOf(uri) ? where : `${where.replace(/\/$/, '')}/${this.dbName}`;
    this.pool = new Pool({ connectionString: uri, connectionTimeoutMillis: 5000, application_name: 'devfactory-simulator' });
  }

  /** A query with the pool, typed for the helpers that also run inside a transaction. */
  private run(text: string, values?: unknown[]) {
    return (this.pool as unknown as QueryRunner).query(text, values);
  }

  async open() {
    // The schema is idempotent, so several simulators can open the same database.
    await this.run(SCHEMA);
    await this.seedIfEmpty();
  }

  async close() {
    await this.pool.end();
  }

  /** Seeds an empty database, or one whose state was cut short or deleted; once at a time. */
  private seedIfEmpty(): Promise<void> {
    this.seeding ??= (async () => {
      const instance = await this.meta<InstanceDoc>('instance');
      if (instance && await this.meta('workflow') && (await this.run('SELECT 1 FROM projects WHERE key = $1', [instance.project])).rowCount) {
        this.projectKey = instance.project;
      } else {
        await this.replaceState(seedState(this.project));
      }
    })().finally(() => { this.seeding = undefined; });
    return this.seeding;
  }

  private async meta<T>(id: string): Promise<T | undefined> {
    const r = await this.run('SELECT doc FROM metadata WHERE id = $1', [id]);
    return r.rows[0]?.doc as T | undefined;
  }

  private async next(counter: string): Promise<number> {
    const r = await this.run('INSERT INTO counters (id, seq) VALUES ($1, 1) ON CONFLICT (id) DO UPDATE SET seq = counters.seq + 1 RETURNING seq', [counter]);
    return r.rows[0].seq;
  }

  async context(retry = true): Promise<SimContext> {
    const [workflow, settings, instance, users, project] = await Promise.all([
      this.meta<WorkflowDoc>('workflow'),
      this.meta<Partial<SimSettings>>('settings'),
      this.meta<InstanceDoc>('instance'),
      this.run('SELECT * FROM users ORDER BY seq'),
      this.run('SELECT * FROM projects WHERE key = $1', [this.projectKey])
    ]);
    if (!workflow || !instance || !project.rows.length) {
      if (!retry) { throw new Error(`The PostgreSQL database ${this.dbName} has no simulator state.`); }
      await this.seedIfEmpty();
      return this.context(false);
    }
    return {
      project: { id: project.rows[0].id, key: project.rows[0].key, name: project.rows[0].name },
      statuses: workflow.statuses, issueTypes: workflow.issueTypes, resolutions: workflow.resolutions, linkTypes: workflow.linkTypes,
      users: users.rows.map((u) => ({ accountId: u.account_id, displayName: u.display_name, emailAddress: u.email_address })),
      me: instance.me,
      settings: { ...DEFAULT_SETTINGS, ...settings }
    };
  }

  async updateUser(accountId: string, patch: Partial<Omit<SimUser, 'accountId'>>) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) { continue; }
      params.push(v);
      sets.push(`${camelToSnake(k)} = $${params.length}`);
    }
    if (!sets.length) { return; }
    params.push(accountId);
    await this.run(`UPDATE users SET ${sets.join(', ')} WHERE account_id = $${params.length}`, params);
  }

  async saveSettings(settings: SimSettings) {
    await this.run(`INSERT INTO metadata (id, doc) VALUES ('settings', $1) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`, [json(settings)]);
  }

  async nextId() {
    return String(await this.next('id'));
  }

  async nextIssueNumber() {
    return this.next(`issue:${this.projectKey}`);
  }

  private async findIssues(q?: IssueQuery): Promise<IssueRow[]> {
    const where: string[] = ['project = $1'];
    const params: unknown[] = [this.projectKey];
    // Jira keys are upper case: a key given in any case is found by its upper-case form, on the unique index.
    if (q?.refs) {
      params.push(q.refs.map((r) => r.toUpperCase()), q.refs);
      where.push(`(key = ANY($${params.length - 1}) OR id = ANY($${params.length}))`);
    }
    if (q?.parent !== undefined) {
      params.push(q.parent);
      where.push(`parent = $${params.length}`);
    }
    return (await this.run(`SELECT * FROM issues WHERE ${where.join(' AND ')} ORDER BY seq`, params)).rows as IssueRow[];
  }

  private toCore(r: IssueRow): IssueCore {
    return {
      id: r.id, key: r.key, type: r.type, summary: r.summary,
      description: r.description, descriptionText: r.description_text ?? undefined,
      labels: r.labels ?? [], status: r.status, resolution: r.resolution, resolutionDate: r.resolution_date,
      parent: r.parent ?? undefined, assignee: r.assignee, reporter: r.reporter, created: r.created, updated: r.updated,
      custom: r.custom ?? {}
    };
  }

  async issues(q?: IssueQuery, opts: { history?: boolean } = {}): Promise<SimIssue[]> {
    const rows = await this.findIssues(q);
    if (!rows.length) { return []; }
    const ids = rows.map((r) => r.id);
    const [comments, worklogs, history] = await Promise.all([
      this.run('SELECT * FROM comments WHERE issue_id = ANY($1) ORDER BY seq', [ids]),
      this.run('SELECT * FROM worklogs WHERE issue_id = ANY($1) ORDER BY seq', [ids]),
      opts.history === false ? { rows: [] } : this.run('SELECT * FROM changelog WHERE issue_id = ANY($1) ORDER BY at, seq', [ids])
    ]);
    const group = (rows: Record<string, any>[]) => {
      const m = new Map<string, Record<string, any>[]>();
      for (const r of rows) { m.set(r.issue_id, [...(m.get(r.issue_id) ?? []), r]); }
      return m;
    };
    const [c, w, h] = [group(comments.rows), group(worklogs.rows), group(history.rows)];
    return rows.map((r) => ({
      ...this.toCore(r),
      comments: (c.get(r.id) ?? []).map((row) => ({ id: row.id, author: row.author, body: row.body, text: row.body_text, created: row.created, updated: row.updated })),
      worklogs: (w.get(r.id) ?? []).map((row) => ({
        id: row.id, author: row.author, timeSpent: row.time_spent, timeSpentSeconds: row.time_spent_seconds, started: row.started, created: row.created
      })),
      history: (h.get(r.id) ?? []).map((row) => ({ at: row.at, author: row.author, field: row.field, from: row.prev ?? undefined, to: row.next ?? undefined }))
    }));
  }

  async briefs(q?: IssueQuery) {
    return (await this.findIssues(q)).map((r) => this.toCore(r));
  }

  async countIssues() {
    const r = await this.run('SELECT count(*) AS n FROM issues WHERE project = $1', [this.projectKey]);
    return Number(r.rows[0].n);
  }

  /** Issues with their comments, worklogs and history, one row at a time. */
  private async insertIssues(runner: QueryRunner, issues: SimIssue[], project: string) {
    if (!issues.length) { return; }
    const issueSql = `INSERT INTO issues
      (id, seq, project, key, type, summary, description, description_text, labels, status, resolution, resolution_date,
       parent, assignee, reporter, created, updated, custom)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;
    for (const { comments, worklogs, history, ...core } of issues) {
      await runner.query(issueSql, [
        core.id, Number(core.id), project, core.key, core.type, core.summary, json(core.description), json(core.descriptionText),
        json(core.labels ?? []), core.status, core.resolution ?? null, core.resolutionDate ?? null, core.parent ?? null,
        core.assignee ?? null, core.reporter, core.created, core.updated, json(core.custom ?? {})
      ]);
      for (const c of comments) {
        await runner.query('INSERT INTO comments (id, seq, issue_id, author, body, body_text, created, updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [c.id, Number(c.id), core.id, c.author, json(c.body), c.text, c.created, c.updated]);
      }
      for (const w of worklogs) {
        await runner.query('INSERT INTO worklogs (id, seq, issue_id, author, time_spent, time_spent_seconds, started, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [w.id, Number(w.id), core.id, w.author, w.timeSpent, w.timeSpentSeconds, w.started, w.created]);
      }
      for (const h of history) {
        await runner.query('INSERT INTO changelog (issue_id, at, author, field, prev, next) VALUES ($1,$2,$3,$4,$5,$6)',
          [core.id, h.at, h.author, h.field, h.from ?? null, h.to ?? null]);
      }
    }
  }

  async insertIssue(issue: SimIssue) {
    await this.insertIssues(this.pool as unknown as QueryRunner, [issue], this.projectKey);
  }

  async updateIssue(id: string, patch: Partial<IssueCore>, changes: SimChange[] = []) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') { continue; }
      params.push(JSONB_COLUMNS.has(k) ? json(v) : v === undefined ? null : v);
      sets.push(`${camelToSnake(k)} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      await this.run(`UPDATE issues SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    }
    for (const c of changes) {
      await this.run('INSERT INTO changelog (issue_id, at, author, field, prev, next) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, c.at, c.author, c.field, c.from ?? null, c.to ?? null]);
    }
  }

  async deleteIssue(issue: IssueCore) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The issue goes first, so what may stay behind is never shown.
      await client.query('DELETE FROM issues WHERE id = $1', [issue.id]);
      await client.query('DELETE FROM comments WHERE issue_id = $1', [issue.id]);
      await client.query('DELETE FROM worklogs WHERE issue_id = $1', [issue.id]);
      await client.query('DELETE FROM changelog WHERE issue_id = $1', [issue.id]);
      await client.query('DELETE FROM links WHERE inward = $1 OR outward = $1', [issue.key]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async addComment(issueId: string, { id, author, body, text, created, updated }: SimComment) {
    await this.run('INSERT INTO comments (id, seq, issue_id, author, body, body_text, created, updated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, Number(id), issueId, author, json(body), text, created, updated]);
  }

  async addWorklog(issueId: string, { id, author, timeSpent, timeSpentSeconds, started, created }: SimWorklog) {
    await this.run('INSERT INTO worklogs (id, seq, issue_id, author, time_spent, time_spent_seconds, started, created) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, Number(id), issueId, author, timeSpent, timeSpentSeconds, started, created]);
  }

  async links(keys?: string[]) {
    const r = await this.run(
      keys ? 'SELECT * FROM links WHERE inward = ANY($1) OR outward = ANY($1) ORDER BY seq' : 'SELECT * FROM links ORDER BY seq',
      keys ? [keys] : []);
    return r.rows.map((l) => ({ id: l.id, type: l.type, inward: l.inward, outward: l.outward }));
  }

  async addLink({ id, ...l }: SimLink) {
    try {
      await this.run('INSERT INTO links (id, seq, type, inward, outward) VALUES ($1,$2,$3,$4,$5)',
        [id, Number(id), l.type, l.inward, l.outward]);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') { return false; } // unique_violation
      throw e;
    }
  }

  async deleteLink(id: string) {
    return (await this.run('DELETE FROM links WHERE id = $1', [id])).rowCount === 1;
  }

  async faults() {
    const r = await this.run('SELECT * FROM faults ORDER BY seq');
    return r.rows.map((f) => ({
      id: f.id, label: f.label, method: f.method, path: f.path, kind: f.kind, status: f.status,
      message: f.message, delayMs: f.delay_ms, remaining: f.remaining, hits: f.hits
    }));
  }

  async addFault({ id, ...f }: SimFault) {
    await this.run('INSERT INTO faults (id, seq, label, method, path, kind, status, message, delay_ms, remaining, hits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, Number(id), f.label, f.method, f.path, f.kind, f.status, f.message, f.delayMs, f.remaining, f.hits]);
  }

  async hitFault(fault: SimFault) {
    if (fault.remaining < 0) {
      const r = await this.run('UPDATE faults SET hits = hits + 1 WHERE id = $1', [fault.id]);
      return r.rowCount === 1;
    }
    // Only while some remain, so concurrent requests cannot use a "once" fault twice.
    const r = await this.run('UPDATE faults SET hits = hits + 1, remaining = remaining - 1 WHERE id = $1 AND remaining > 0 RETURNING remaining', [fault.id]);
    if (!r.rows.length) { return false; }
    if (r.rows[0].remaining === 0) { await this.run('DELETE FROM faults WHERE id = $1 AND remaining = 0', [fault.id]); }
    return true;
  }

  async deleteFault(id: string) {
    await this.run('DELETE FROM faults WHERE id = $1', [id]);
  }

  async clearFaults() {
    await this.run('DELETE FROM faults');
  }

  async addLog(entry: Omit<LogEntry, 'id'>, bodies: LogBodies) {
    const id = await this.next('requestLog');
    await this.run(`INSERT INTO request_log
      (n, at, method, path, status, ms, user_email, fault, error, request, response) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, entry.at, entry.method, entry.path, entry.status, entry.ms, entry.user ?? null, entry.fault ?? null, entry.error ?? null,
        json(bodies.request), json(bodies.response)]);
    if (id % 25 === 0) { await this.run('DELETE FROM request_log WHERE n <= $1', [id - LOG_SIZE]); }
    return id;
  }

  async log(limit: number) {
    const r = await this.run('SELECT * FROM request_log ORDER BY n DESC LIMIT $1', [limit]);
    return r.rows.reverse().map((row) => ({
      id: row.n, at: row.at, method: row.method, path: row.path, status: row.status, ms: row.ms,
      user: row.user_email ?? undefined, fault: row.fault ?? undefined, error: row.error ?? undefined
    }));
  }

  async logBodies(id: number) {
    const r = await this.run('SELECT request, response FROM request_log WHERE n = $1', [id]);
    return r.rows[0] ? { request: r.rows[0].request, response: r.rows[0].response } : undefined;
  }

  async clearLog() {
    await this.run('DELETE FROM request_log');
  }

  async exportState(): Promise<SimState> {
    const ctx = await this.context();
    const [issues, links, faults, counters] = await Promise.all([
      this.issues(), this.links(), this.faults(), this.run('SELECT id, seq FROM counters WHERE id = ANY($1)', [['id', `issue:${this.projectKey}`]])
    ]);
    const last = (id: string) => Number(counters.rows.find((c) => c.id === id)?.seq ?? 0);
    return {
      version: 1, project: ctx.project, statuses: ctx.statuses, issueTypes: ctx.issueTypes, resolutions: ctx.resolutions, linkTypes: ctx.linkTypes,
      users: ctx.users, me: ctx.me, nextId: last('id') + 1, nextNumber: last(`issue:${this.projectKey}`) + 1, issues, links, settings: ctx.settings, faults
    };
  }

  async replaceState(s: SimState) {
    const client = await this.pool.connect();
    const runner = client as unknown as QueryRunner;
    try {
      await client.query('BEGIN');
      // PostgreSQL has transactions: the whole replacement is one, and one cut short changes nothing.
      // The instance row still goes last, mirroring the MongoDB storage.
      await runner.query(`DELETE FROM metadata WHERE id = 'instance'`);
      for (const t of ['projects', 'users', 'issues', 'comments', 'worklogs', 'changelog', 'links', 'faults']) {
        await runner.query(`DELETE FROM ${t}`);
      }
      await runner.query('DELETE FROM metadata');
      await runner.query(`DELETE FROM counters WHERE id <> 'requestLog'`);
      const project = s.project.key;
      await runner.query('INSERT INTO projects (id, key, name) VALUES ($1,$2,$3)', [s.project.id, project, s.project.name]);
      await runner.query(`INSERT INTO metadata (id, doc) VALUES ('workflow', $1), ('settings', $2)`,
        [json({ statuses: s.statuses, issueTypes: s.issueTypes, resolutions: s.resolutions, linkTypes: s.linkTypes }), json({ ...DEFAULT_SETTINGS, ...s.settings })]);
      for (const [n, { accountId, ...u }] of s.users.entries()) {
        await runner.query('INSERT INTO users (account_id, seq, display_name, email_address) VALUES ($1,$2,$3,$4)',
          [accountId, n, u.displayName, u.emailAddress]);
      }
      await this.insertIssues(runner, s.issues, project);
      for (const { id, ...l } of s.links) {
        try {
          await runner.query('INSERT INTO links (id, seq, type, inward, outward) VALUES ($1,$2,$3,$4,$5)',
            [id, Number(id), l.type, l.inward, l.outward]);
        } catch (e) {
          if ((e as { code?: string }).code !== '23505') { throw e; }
        }
      }
      for (const { id, ...f } of s.faults) {
        await runner.query('INSERT INTO faults (id, seq, label, method, path, kind, status, message, delay_ms, remaining, hits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [id, Number(id), f.label, f.method, f.path, f.kind, f.status, f.message, f.delayMs, f.remaining, f.hits]);
      }
      await runner.query(`INSERT INTO counters (id, seq) VALUES ('id', $1), ($2, $3)`, [s.nextId - 1, `issue:${project}`, s.nextNumber - 1]);
      this.projectKey = project;
      await runner.query(`INSERT INTO metadata (id, doc) VALUES ('instance', $1)`,
        [json({ version: 1, me: s.me, project, writtenAt: new Date().toISOString() })]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}