// Jira simulator: the subset of the Jira Cloud REST API v3 the DevFactory extension uses, on 127.0.0.1, with the seeded epic and task workflows,
// Jira's validation and error formats, injectable faults, a request log and a dashboard to watch and change the state.
// No dependency on VS Code: it runs as its own process, started by `jira-sim` (the npm bin), `node out/cli.js` or docker compose.
// The state is behind a SimStorage (storage.ts): a JSON file or memory by default, MongoDB or PostgreSQL from the CLI.
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { adfToText, textToAdf } from './jiraFormat';
import { compileJql, JqlError, parseJql } from './jql';
import { DEFAULT_PROJECT, seedState } from './seed';
import { FileStorage, SimContext, SimStorage } from './storage';
import {
  DEFAULT_SETTINGS, durationSeconds, formatSeconds, IssueCore, jiraTime, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink,
  SimSettings, SimState, SimTransition, SimWorklog, STATUS_CATEGORIES, statusOf, transitionsOf
} from './types';

export type { LogEntry } from './types';

export const SIM_ID = 'devfactory-simulator';
export const DEFAULT_PORT = 4865;

export interface SimulatorOptions {
  port?: number;
  host?: string;
  /** The URL clients reach it at, used in `self` links; http://127.0.0.1:<port> by default. */
  publicUrl?: string;
  /** Where the state is kept; by default the stateFile below. */
  storage?: SimStorage;
  /** Where the state is kept between runs, without a storage; in memory only when absent. */
  stateFile?: string;
  /** The project key of the empty seed, when the CLI does not name one. */
  project?: string;
  /** The dashboard page; defaults to media/simulator.html next to out/. */
  dashboardFile?: string;
}

/** A Jira error answer: status, errorMessages and per-field errors. */
class ApiError extends Error {
  constructor(readonly status: number, readonly messages: string[], readonly errors: Record<string, string> = {}) {
    super(messages[0] ?? Object.values(errors)[0] ?? `HTTP ${status}`);
  }
}

const notFound = () => new ApiError(404, ['Issue does not exist or you do not have permission to see it.']);
const fieldErrors = (errors: Record<string, string>) => new ApiError(400, [], errors);

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A request's context with the issues its JSON refers to (parents, linked issues) and their links. */
type View = SimContext & { byKey: Map<string, IssueCore>; links: SimLink[] };

export const FAULT_PRESETS: Record<string, Omit<SimFault, 'id' | 'hits'>> = {
  'token-expired': { label: 'Token expired', method: '*', path: '/rest/', kind: 'error', status: 401, message: 'Client must be authenticated to access this resource.', delayMs: 0, remaining: -1 },
  'no-permission': { label: 'No permission to create', method: 'POST', path: '/rest/api/3/issue', kind: 'error', status: 403, message: 'You do not have permission to create issues in this project.', delayMs: 0, remaining: -1 },
  'rate-limited': { label: 'Rate limited once', method: '*', path: '/rest/', kind: 'error', status: 429, message: 'Rate limit exceeded.', delayMs: 0, remaining: 1 },
  'jira-down': { label: 'Jira down', method: '*', path: '/rest/', kind: 'error', status: 503, message: 'Service Unavailable', delayMs: 0, remaining: -1 },
  'network-drop': { label: 'Connection dropped once', method: '*', path: '/rest/', kind: 'drop', status: 0, message: '', delayMs: 0, remaining: 1 },
  slow: { label: 'Slow Jira (3 s)', method: '*', path: '/rest/', kind: 'delay', status: 0, message: '', delayMs: 3000, remaining: -1 },
  'create-fails': { label: 'Next create refused', method: 'POST', path: '/rest/api/3/issue', kind: 'error', status: 400, message: "Field 'customfield_10020' is required.", delayMs: 0, remaining: 1 },
  'transition-fails': { label: 'Next transition refused', method: 'POST', path: '/transitions', kind: 'error', status: 400, message: 'The transition was refused by a workflow validator.', delayMs: 0, remaining: 1 },
  'link-fails': { label: 'Next link fails', method: 'POST', path: '/rest/api/3/issueLink', kind: 'error', status: 500, message: 'Internal server error', delayMs: 0, remaining: 1 },
  'search-fails': { label: 'Next search fails', method: 'POST', path: '/search/jql', kind: 'error', status: 500, message: 'Internal server error', delayMs: 0, remaining: 1 }
};

const CREATE_FIELDS = new Set(['project', 'issuetype', 'summary', 'description', 'labels', 'parent', 'assignee', 'reporter']);

export class JiraSimulator {
  url = '';
  readonly storage: SimStorage;
  private server?: http.Server;
  private readonly listeners = new Set<http.ServerResponse>();
  private notifyTimer?: NodeJS.Timeout;

  constructor(private readonly opts: SimulatorOptions = {}) {
    this.storage = opts.storage ?? new FileStorage(opts.stateFile, opts.project ?? DEFAULT_PROJECT);
  }

  async start(): Promise<string> {
    await this.storage.open();
    const server = http.createServer((req, res) => void this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.opts.port ?? DEFAULT_PORT, this.opts.host ?? '127.0.0.1', () => resolve());
      });
    } catch (e) {
      await this.storage.close();
      throw e;
    }
    this.server = server;
    const addr = server.address() as { port: number };
    this.url = this.opts.publicUrl?.replace(/\/+$/, '') || `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop() {
    for (const l of this.listeners) { l.end(); }
    this.listeners.clear();
    clearTimeout(this.notifyTimer);
    this.notifyTimer = undefined;
    await new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.server = undefined;
    await this.storage.close();
  }

  /** The project and its number of issues, for the CLI's banner. */
  async summary() {
    const [ctx, issues] = await Promise.all([this.storage.context(), this.storage.countIssues()]);
    return { project: ctx.project.key, issues };
  }

  async reset(project = this.opts.project ?? DEFAULT_PROJECT) {
    const keep = (await this.storage.context()).settings;
    const state = seedState(project);
    state.settings = { ...DEFAULT_SETTINGS, ...keep };
    await this.storage.replaceState(state);
    this.changed();
  }

  // ---- change notification ----

  /** The dashboards reload a moment after anything changed. */
  private changed() {
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = undefined;
      for (const l of this.listeners) { l.write('data: change\n\n'); }
    }, 80);
  }

  // ---- HTTP ----

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://simulator');
    const raw = await new Promise<string>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => resolve(b));
    });
    try {
      if (!url.pathname.startsWith('/rest/')) {
        await this.dashboard(req, res, url, raw);
        return;
      }
      await this.api(req, res, url, raw);
    } catch (e) {
      if (!res.headersSent) { send(res, { status: 500, body: { errorMessages: [String(e instanceof Error ? e.stack : e)] } }); }
    }
  }

  /** A REST call of the client: latency, faults, auth, then the route; every call is logged. */
  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, raw: string) {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const entry: Omit<LogEntry, 'id'> = { at: new Date().toISOString(), method, path: url.pathname + url.search, status: 0, ms: 0 };
    let request: unknown;
    let reply: Reply;
    try {
      request = raw ? JSON.parse(raw) : undefined;
    } catch {
      request = raw;
    }
    const [ctx, faults] = await Promise.all([this.storage.context(), this.storage.faults()]);
    let fault = faults.find((f) => (f.method === '*' || f.method === method) && url.pathname.includes(f.path) && f.remaining !== 0);
    const delay = ctx.settings.latencyMs + (fault?.kind === 'delay' ? fault.delayMs : 0);
    if (delay > 0) { await new Promise((r) => setTimeout(r, delay)); }
    if (fault) {
      // Another request may have used up its last time meanwhile.
      if (await this.storage.hitFault(fault)) {
        entry.fault = fault.label;
        this.changed();
      } else {
        fault = undefined;
      }
    }
    if (fault?.kind === 'drop') {
      entry.status = 0;
      entry.error = 'connection dropped';
      entry.ms = Date.now() - started;
      await this.record(entry, request, undefined);
      req.socket.destroy();
      return;
    }
    if (fault?.kind === 'error') {
      reply = { status: fault.status, body: { errorMessages: [fault.message], errors: {} }, headers: fault.status === 429 ? { 'Retry-After': '5' } : undefined };
    } else {
      const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      const user = auth ? Buffer.from(auth[1], 'base64').toString().split(':')[0] : undefined;
      entry.user = user;
      if (!user) {
        reply = { status: 401, body: { errorMessages: ['Client must be authenticated to access this resource.'], errors: {} } };
      } else if (typeof request === 'string') {
        reply = { status: 400, body: { errorMessages: ['Unexpected character in the request body: it is not valid JSON.'], errors: {} } };
      } else {
        await this.signIn(ctx, user);
        try {
          reply = await this.route(ctx, method, url, request as Record<string, any> | undefined);
        } catch (e) {
          if (!(e instanceof ApiError)) { throw e; }
          reply = { status: e.status, body: { errorMessages: e.messages, errors: e.errors } };
        }
      }
    }
    entry.status = reply.status;
    entry.ms = Date.now() - started;
    if (reply.status >= 400) {
      const b = reply.body as { errorMessages?: string[]; errors?: Record<string, string> };
      entry.error = [...(b?.errorMessages ?? []), ...Object.entries(b?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ');
    }
    await this.record(entry, request, reply.body);
    send(res, reply);
  }

  private async record(entry: Omit<LogEntry, 'id'>, request: unknown, response: unknown) {
    await this.storage.addLog(entry, { request, response });
    this.changed();
  }

  /** Any credentials sign in as the simulated "me"; its email and name follow the client's. */
  private async signIn(ctx: SimContext, email: string) {
    const me = ctx.users.find((u) => u.accountId === ctx.me)!;
    if (me.emailAddress !== email && email.includes('@')) {
      me.emailAddress = email;
      me.displayName = email.split('@')[0].split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'You';
      await this.storage.updateUser(me.accountId, { emailAddress: me.emailAddress, displayName: me.displayName });
      this.changed();
    }
  }

  private async route(ctx: SimContext, method: string, url: URL, body: Record<string, any> | undefined): Promise<Reply> {
    const p = url.pathname.replace(/\/+$/, '');
    const m = (re: RegExp) => re.exec(p);
    let r: RegExpExecArray | null;
    if (p === '/rest/api/3/myself' && method === 'GET') { return ok(this.userJson(ctx, ctx.me)); }
    if (p === '/rest/api/3/serverInfo') { return ok({ baseUrl: this.url, version: '1001.0.0-SNAPSHOT', deploymentType: 'Cloud', serverTitle: 'Jira simulator' }); }
    if (/^\/rest\/api\/[23]\/search$/.test(p)) {
      throw new ApiError(410, ['The requested API has been removed. Please migrate to the /rest/api/3/search/jql API. A full migration guideline is available at https://developer.atlassian.com/changelog/#CHANGE-2046']);
    }
    if (p === '/rest/api/3/search/jql') {
      if (method === 'POST') { return ok(await this.search(ctx, body ?? {})); }
      if (method === 'GET') {
        const q = url.searchParams;
        return ok(await this.search(ctx, { jql: q.get('jql') ?? '', fields: q.get('fields')?.split(','), maxResults: q.get('maxResults') ? Number(q.get('maxResults')) : undefined, nextPageToken: q.get('nextPageToken') ?? undefined }));
      }
    }
    if (p === '/rest/api/3/issue' && method === 'POST') { return { status: 201, body: await this.create(ctx, body?.fields ?? {}, ctx.me) }; }
    if ((r = m(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/))) {
      const issue = await this.issue(r[1]);
      if (method === 'GET') { return ok({ expand: 'transitions', transitions: transitionsOf(ctx, issue).map((t) => this.transitionJson(ctx, t, url.searchParams.get('expand')?.includes('transitions.fields'))) }); }
      if (method === 'POST') {
        const id = String(body?.transition?.id ?? '');
        await this.transition(ctx, issue, id, body?.fields ?? {}, body?.update ?? {}, ctx.me);
        return { status: 204 };
      }
    }
    if ((r = m(/^\/rest\/api\/3\/issue\/([^/]+)\/comment$/))) {
      const issue = await this.issue(r[1]);
      if (method === 'GET') { return ok({ startAt: 0, maxResults: 5000, total: issue.comments.length, comments: issue.comments.map((c) => this.commentJson(ctx, issue, c)) }); }
      if (method === 'POST') { return { status: 201, body: this.commentJson(ctx, issue, await this.comment(issue, body?.body, ctx.me)) }; }
    }
    if ((r = m(/^\/rest\/api\/3\/issue\/([^/]+)\/worklog$/))) {
      const issue = await this.issue(r[1]);
      if (method === 'GET') { return ok({ startAt: 0, maxResults: 5000, total: issue.worklogs.length, worklogs: issue.worklogs.map((w) => this.worklogJson(ctx, issue, w)) }); }
      if (method === 'POST') { return { status: 201, body: this.worklogJson(ctx, issue, await this.worklog(issue, body ?? {}, ctx.me)) }; }
    }
    if ((r = m(/^\/rest\/api\/3\/issue\/([^/]+)$/))) {
      const issue = await this.issue(r[1]);
      if (method === 'GET') { return ok(this.issueJson(await this.view(ctx, [issue]), issue, url.searchParams.get('fields')?.split(','))); }
      if (method === 'PUT') { await this.edit(ctx, issue, body?.fields ?? {}, body?.update ?? {}, ctx.me); return { status: 204 }; }
      if (method === 'DELETE') { await this.remove(issue); return { status: 204 }; }
    }
    if (p === '/rest/api/3/issueLink' && method === 'POST') { await this.link(ctx, body ?? {}); return { status: 201 }; }
    if ((r = m(/^\/rest\/api\/3\/issueLink\/(\d+)$/)) && method === 'DELETE') {
      if (!(await this.storage.deleteLink(r[1]))) { throw new ApiError(404, ['No issue link with id ' + r[1] + ' exists.']); }
      this.changed();
      return { status: 204 };
    }
    if (p === '/rest/api/3/issueLinkType') { return ok({ issueLinkTypes: ctx.linkTypes.map((t) => ({ ...t, self: `${this.url}/rest/api/3/issueLinkType/${t.id}` })) }); }
    if (p === '/rest/api/3/status') { return ok(ctx.statuses.map((s) => this.statusJson(ctx, s.name))); }
    if (p === '/rest/api/3/resolution') { return ok(ctx.resolutions.map((name, n) => ({ id: String(10000 + n), name, description: '' }))); }
    if (p === '/rest/api/3/issuetype') { return ok(ctx.issueTypes.map((t) => this.typeJson(ctx, t.name))); }
    if ((r = m(/^\/rest\/api\/3\/project\/([^/]+)$/))) {
      const pr = ctx.project;
      if (![pr.key, pr.id].includes(r[1].toUpperCase()) && r[1] !== pr.id) { throw new ApiError(404, [`No project could be found with key '${r[1]}'.`]); }
      return ok({ ...pr, self: `${this.url}/rest/api/3/project/${pr.id}`, projectTypeKey: 'software', simplified: false, issueTypes: ctx.issueTypes.map((t) => this.typeJson(ctx, t.name)) });
    }
    throw new ApiError(404, [`The Jira simulator does not implement ${method} ${p}.`]);
  }

  // ---- operations, shared by the REST API and the dashboard ----

  /** The issue by key (any case) or id, with its comments, worklogs and history. */
  private async issue(ref: string): Promise<SimIssue> {
    const [i] = await this.storage.issues({ refs: [ref] });
    if (!i) { throw notFound(); }
    return i;
  }

  /** The issue by key (any case) or id, without its comments, worklogs and history. */
  private async brief(ref: string): Promise<IssueCore> {
    const [i] = await this.storage.briefs({ refs: [ref] });
    if (!i) { throw notFound(); }
    return i;
  }

  /** The context with what the JSON of these issues refers to: their links, parents and linked issues. */
  private async view(ctx: SimContext, issues: IssueCore[], known: IssueCore[] = issues): Promise<View> {
    const links = await this.storage.links(issues.map((i) => i.key));
    const byKey = new Map(known.map((i) => [i.key, i]));
    const missing = [...new Set([...issues.map((i) => i.parent), ...links.flatMap((l) => [l.inward, l.outward])])]
      .filter((k): k is string => !!k && !byKey.has(k));
    if (missing.length) {
      for (const i of await this.storage.briefs({ refs: missing })) { byKey.set(i.key, i); }
    }
    return { ...ctx, byKey, links };
  }

  /** JQL is evaluated in memory over the project's issues, the same way whatever the storage. */
  private async search(ctx: SimContext, b: { jql?: string; fields?: string[]; maxResults?: number; nextPageToken?: string }) {
    let q;
    let compiled;
    const issues = await this.storage.issues(undefined, { history: false });
    try {
      q = parseJql(String(b.jql ?? ''));
      compiled = compileJql(q, { ...ctx, issues }, ctx.me);
    } catch (e) {
      if (e instanceof JqlError) { throw new ApiError(400, [e.message]); }
      throw e;
    }
    const all = issues.filter(compiled.match).sort(compiled.compare);
    let start = 0;
    if (b.nextPageToken) {
      try {
        const t = JSON.parse(Buffer.from(b.nextPageToken, 'base64url').toString());
        if (t.jql !== b.jql) { throw new Error(); }
        start = Number(t.at) || 0;
      } catch {
        throw new ApiError(400, ['The provided next page token is invalid or expired.']);
      }
    }
    const size = Math.max(1, Math.min(b.maxResults ?? 50, 5000, ctx.settings.pageSize));
    const page = all.slice(start, start + size);
    const more = start + size < all.length;
    const view = await this.view(ctx, page, issues);
    return {
      issues: page.map((i) => this.issueJson(view, i, b.fields ?? ['id'])),
      ...(more ? { nextPageToken: Buffer.from(JSON.stringify({ jql: b.jql, at: start + size })).toString('base64url') } : {}),
      isLast: !more
    };
  }

  async create(ctx: SimContext, fields: Record<string, any>, actor: string): Promise<{ id: string; key: string; self: string }> {
    const errors: Record<string, string> = {};
    const projectRef = fields.project?.key ?? fields.project?.id;
    if (!projectRef) { errors.project = 'Specify a valid project ID or key'; } else if (![ctx.project.key, ctx.project.id].includes(String(projectRef).toUpperCase()) && String(projectRef) !== ctx.project.id) { errors.project = 'valid project is required'; }
    const typeRef = fields.issuetype?.name ?? fields.issuetype?.id;
    const type = ctx.issueTypes.find((t) => t.name.toLowerCase() === String(typeRef ?? '').toLowerCase() || t.id === String(typeRef));
    if (!typeRef) { errors.issuetype = 'Specify an issue type'; } else if (!type) { errors.issuetype = 'The issue type selected is invalid.'; }
    await this.checkFields(ctx, fields, errors, type?.name);
    for (const k of Object.keys(fields)) {
      if (!CREATE_FIELDS.has(k) && !/^customfield_\d+$/.test(k)) { errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`; }
    }
    if (!fields.summary && !errors.summary) { errors.summary = 'You must specify a summary of the issue.'; }
    if (type?.name === 'Epic' && ctx.settings.epicNameRequired && !fields.customfield_10011) { errors.customfield_10011 = 'Epic Name is required.'; }
    if (Object.keys(errors).length) { throw fieldErrors(errors); }

    const now = jiraTime();
    const assignee = fields.assignee !== undefined ? fields.assignee?.accountId ?? null : ctx.settings.newIssueAssignee === 'reporter' ? actor : null;
    const parent = fields.parent ? (await this.brief(String(fields.parent.key ?? fields.parent.id))).key : undefined;
    const id = await this.storage.nextId();
    const issue: SimIssue = {
      id, key: `${ctx.project.key}-${await this.storage.nextIssueNumber()}`, type: type!.name, summary: String(fields.summary).trim(),
      description: fields.description ?? null, descriptionText: fields.description ? adfToText(fields.description) : undefined,
      labels: fields.labels ?? [], status: 'Open', resolution: null, resolutionDate: null,
      parent, assignee, reporter: fields.reporter?.accountId ?? actor, created: now, updated: now,
      comments: [], worklogs: [], history: [{ at: now, author: actor, field: 'created' }],
      custom: Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith('customfield_')))
    };
    await this.storage.insertIssue(issue);
    this.changed();
    return { id: issue.id, key: issue.key, self: `${this.url}/rest/api/3/issue/${issue.id}` };
  }

  /** Checks shared by create and edit, in Jira's words. */
  private async checkFields(ctx: SimContext, fields: Record<string, any>, errors: Record<string, string>, type?: string) {
    if (fields.summary !== undefined) {
      const sum = String(fields.summary ?? '');
      if (!sum.trim()) { errors.summary = 'You must specify a summary of the issue.'; } else if (/[\r\n]/.test(sum)) { errors.summary = 'The summary is invalid because it contains newline characters.'; } else if (sum.length > 255) { errors.summary = 'Summary must be less than 255 characters.'; }
    }
    if (fields.description !== undefined && fields.description !== null && !isAdf(fields.description)) {
      errors.description = 'Operation value must be an Atlassian Document (see the Atlassian Document Format)';
    }
    if (fields.labels !== undefined) {
      if (!Array.isArray(fields.labels) || fields.labels.some((l: unknown) => typeof l !== 'string')) { errors.labels = 'Operation value must be an array of strings.'; } else {
        const bad = (fields.labels as string[]).find((l) => /\s/.test(l));
        if (bad) { errors.labels = `The label '${bad}' contains spaces which is invalid.`; }
      }
    }
    if (fields.parent !== undefined && fields.parent !== null) {
      const ref = String(fields.parent.key ?? fields.parent.id ?? '');
      const [parent] = await this.storage.briefs({ refs: [ref] });
      const level = (t?: string) => ctx.issueTypes.find((x) => x.name === t)?.hierarchyLevel ?? 0;
      if (!parent) { errors.parent = `Could not find issue by id or key '${ref}'.`; } else if (level(parent.type) !== level(type) + 1) { errors.parent = 'Given parent work item does not belong to appropriate hierarchy.'; }
    }
    for (const k of ['assignee', 'reporter']) {
      const v = fields[k];
      if (v && v.accountId !== null && !ctx.users.some((u) => u.accountId === v.accountId)) { errors[k] = `Specified user '${v.accountId}' does not exist or you do not have required permissions.`; }
    }
  }

  async edit(ctx: SimContext, issue: SimIssue, fields: Record<string, any>, update: Record<string, any[]>, actor: string) {
    const errors: Record<string, string> = {};
    for (const k of Object.keys(fields)) {
      if (!['summary', 'description', 'labels', 'parent', 'assignee'].includes(k) && !/^customfield_\d+$/.test(k)) { errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`; }
    }
    await this.checkFields(ctx, fields, errors, issue.type);
    if (Object.keys(errors).length) { throw fieldErrors(errors); }
    const patch: Partial<IssueCore> = {};
    const changes: SimChange[] = [];
    const change = (field: string, from: unknown, to: unknown) => changes.push({ at: jiraTime(), author: actor, field, from: show(from), to: show(to) });
    if (fields.summary !== undefined && fields.summary !== issue.summary) { change('summary', issue.summary, fields.summary); patch.summary = String(fields.summary).trim(); }
    if (fields.description !== undefined) { change('description', '…', '…'); patch.description = fields.description; patch.descriptionText = fields.description ? adfToText(fields.description) : undefined; }
    let labels = fields.labels as string[] | undefined;
    for (const op of update.labels ?? []) {
      labels ??= [...issue.labels];
      if (op.add) { labels.push(op.add); }
      if (op.remove) { labels = labels.filter((l) => l !== op.remove); }
    }
    if (labels) { change('labels', issue.labels.join(' '), labels.join(' ')); patch.labels = [...new Set(labels)]; }
    if (fields.assignee !== undefined) { change('assignee', this.name(ctx, issue.assignee), this.name(ctx, fields.assignee?.accountId ?? null)); patch.assignee = fields.assignee?.accountId ?? null; }
    if (fields.parent !== undefined) { change('parent', issue.parent, fields.parent?.key); patch.parent = fields.parent ? (await this.brief(String(fields.parent.key ?? fields.parent.id))).key : undefined; }
    const custom = Object.entries(fields).filter(([k]) => k.startsWith('customfield_'));
    if (custom.length) { patch.custom = { ...issue.custom, ...Object.fromEntries(custom) }; }
    patch.updated = jiraTime();
    await this.storage.updateIssue(issue.id, patch, changes);
    this.changed();
  }

  async remove(issue: IssueCore) {
    const children = await this.storage.briefs({ parent: issue.key });
    if (children.length) { throw new ApiError(400, [`The issue has ${children.length} child issue(s); delete them first or move them to another parent.`]); }
    await this.storage.deleteIssue(issue);
    this.changed();
  }

  async transition(ctx: SimContext, issue: SimIssue, id: string, fields: Record<string, any>, update: Record<string, any[]>, actor: string) {
    const t = transitionsOf(ctx, issue).find((x) => x.id === id);
    if (!t) { throw new ApiError(400, [`Transition id '${id}' is not valid for this issue.`]); }
    const toDone = statusOf(ctx, t.to).category === 'done';
    const errors: Record<string, string> = {};
    for (const k of Object.keys(fields)) {
      if (k !== 'resolution' || !toDone) { errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`; }
    }
    const resName = fields.resolution?.name ?? (fields.resolution?.id ? ctx.resolutions[Number(fields.resolution.id) - 10000] : undefined);
    if (fields.resolution && toDone && !ctx.resolutions.includes(resName)) { errors.resolution = "Could not find valid 'id' or 'name' in resolution object."; }
    if (toDone && !fields.resolution && ctx.settings.resolutionRequired) { errors.resolution = 'Resolution is required.'; }
    if (Object.keys(errors).length) { throw fieldErrors(errors); }
    const addWorklog = update.worklog?.find((w) => w.add)?.add;
    if (toDone && issue.type !== 'Epic' && ctx.settings.worklogRequired && !issue.worklogs.length && !addWorklog) {
      throw new ApiError(400, ['Log the time spent before closing: the workflow requires time spent on Done (validator of the simulator).']);
    }
    if (t.to === 'In Review' && issue.type === 'Epic' && ctx.settings.reviewNeedsTasksDone) {
      const open = (await this.storage.briefs({ parent: issue.key })).filter((i) => statusOf(ctx, i.status).category !== 'done');
      if (open.length) { throw new ApiError(400, [`All tasks must be Done before review: ${open.map((i) => i.key).join(', ')} still open (validator of the simulator).`]); }
    }
    if (addWorklog) { await this.worklog(issue, addWorklog, actor); }
    for (const c of update.comment ?? []) { if (c.add) { await this.comment(issue, c.add.body, actor); } }
    const changes: SimChange[] = [{ at: jiraTime(), author: actor, field: 'status', from: issue.status, to: t.to }];
    const patch: Partial<IssueCore> = { status: t.to };
    if (toDone) {
      patch.resolution = resName ?? 'Done';
      patch.resolutionDate = jiraTime();
      changes.push({ at: jiraTime(), author: actor, field: 'resolution', to: patch.resolution ?? undefined });
    } else if (issue.resolution) {
      patch.resolution = null;
      patch.resolutionDate = null;
    }
    patch.updated = jiraTime();
    await this.storage.updateIssue(issue.id, patch, changes);
    this.changed();
  }

  async comment(issue: IssueCore, body: unknown, actor: string): Promise<SimComment> {
    if (!isAdf(body)) { throw fieldErrors({ comment: 'Comment body is not valid: it must be an Atlassian Document.' }); }
    const text = adfToText(body);
    if (!text.trim()) { throw fieldErrors({ comment: 'Comment body can not be empty!' }); }
    const now = jiraTime();
    const c: SimComment = { id: await this.storage.nextId(), author: actor, body, text, created: now, updated: now };
    await this.storage.addComment(issue.id, c);
    await this.touch(issue);
    return c;
  }

  async worklog(issue: IssueCore, b: { timeSpent?: string; timeSpentSeconds?: number; started?: string }, actor: string): Promise<SimWorklog> {
    const seconds = b.timeSpentSeconds ?? (b.timeSpent !== undefined ? durationSeconds(String(b.timeSpent)) : undefined);
    if (b.timeSpent === undefined && b.timeSpentSeconds === undefined) { throw fieldErrors({ timeLogged: 'You must indicate the time spent working.' }); }
    if (!seconds || seconds <= 0) { throw fieldErrors({ timeLogged: 'Invalid time duration entered.' }); }
    const now = jiraTime();
    const w: SimWorklog = { id: await this.storage.nextId(), author: actor, timeSpent: b.timeSpent ?? formatSeconds(seconds), timeSpentSeconds: seconds, started: b.started ?? now, created: now };
    await this.storage.addWorklog(issue.id, w);
    await this.storage.updateIssue(issue.id, { updated: jiraTime() }, [{ at: now, author: actor, field: 'timespent', to: w.timeSpent }]);
    this.changed();
    return w;
  }

  async link(ctx: SimContext, b: Record<string, any>) {
    const type = ctx.linkTypes.find((t) => t.name.toLowerCase() === String(b.type?.name ?? '').toLowerCase() || t.id === String(b.type?.id));
    if (!type) { throw new ApiError(404, [`No issue link type with name '${b.type?.name ?? b.type?.id ?? ''}' found.`]); }
    const inward = await this.brief(String(b.inwardIssue?.key ?? b.inwardIssue?.id ?? ''));
    const outward = await this.brief(String(b.outwardIssue?.key ?? b.outwardIssue?.id ?? ''));
    if (inward.id === outward.id) { throw new ApiError(400, ['You cannot link an issue to itself.']); }
    const same = (l: SimLink) => l.type === type.name && l.inward === inward.key && l.outward === outward.key;
    if (!(await this.storage.links([inward.key])).some(same)) {
      await this.storage.addLink({ id: await this.storage.nextId(), type: type.name, inward: inward.key, outward: outward.key });
    }
    await this.touch(inward);
    await this.touch(outward);
  }

  private async touch(issue: IssueCore) {
    await this.storage.updateIssue(issue.id, { updated: jiraTime() });
    this.changed();
  }

  // ---- JSON as Jira returns it ----

  private name(ctx: SimContext, accountId: string | null) {
    return accountId ? ctx.users.find((u) => u.accountId === accountId)?.displayName ?? accountId : 'Unassigned';
  }

  private userJson(ctx: SimContext, accountId: string | null) {
    const u = ctx.users.find((x) => x.accountId === accountId);
    if (!u) { return null; }
    return { self: `${this.url}/rest/api/3/user?accountId=${u.accountId}`, accountId: u.accountId, emailAddress: u.emailAddress, displayName: u.displayName, active: true, timeZone: 'Europe/Paris', accountType: 'atlassian' };
  }

  private statusJson(ctx: SimContext, name: string) {
    const st = statusOf(ctx, name);
    const c = STATUS_CATEGORIES[st.category];
    return { self: `${this.url}/rest/api/3/status/${st.id}`, description: '', name: st.name, id: st.id, statusCategory: { self: `${this.url}/rest/api/3/statuscategory/${c.id}`, id: c.id, key: c.key, colorName: c.colorName, name: c.name } };
  }

  private typeJson(ctx: SimContext, name: string) {
    const t = ctx.issueTypes.find((x) => x.name === name)!;
    return { self: `${this.url}/rest/api/3/issuetype/${t.id}`, id: t.id, name: t.name, subtask: t.hierarchyLevel < 0, hierarchyLevel: t.hierarchyLevel };
  }

  private transitionJson(ctx: SimContext, t: SimTransition, withFields?: boolean) {
    const toDone = statusOf(ctx, t.to).category === 'done';
    return {
      id: t.id, name: t.name, to: this.statusJson(ctx, t.to), hasScreen: toDone, isGlobal: t.from === '*', isInitial: false, isAvailable: true, isConditional: false, isLooped: false,
      ...(withFields ? { fields: toDone ? { resolution: { required: ctx.settings.resolutionRequired, schema: { type: 'resolution', system: 'resolution' }, name: 'Resolution', key: 'resolution', operations: ['set'], allowedValues: ctx.resolutions.map((name, n) => ({ id: String(10000 + n), name })) } } : {} } : {})
    };
  }

  private commentJson(ctx: SimContext, issue: IssueCore, c: SimComment) {
    return { self: `${this.url}/rest/api/3/issue/${issue.id}/comment/${c.id}`, id: c.id, author: this.userJson(ctx, c.author), body: c.body, created: c.created, updated: c.updated, jsdPublic: true };
  }

  private worklogJson(ctx: SimContext, issue: IssueCore, w: SimWorklog) {
    return { self: `${this.url}/rest/api/3/issue/${issue.id}/worklog/${w.id}`, id: w.id, issueId: issue.id, author: this.userJson(ctx, w.author), timeSpent: w.timeSpent, timeSpentSeconds: w.timeSpentSeconds, started: w.started, created: w.created, updated: w.created };
  }

  private linksJson(view: View, issue: IssueCore) {
    const brief = (key: string) => {
      const i = view.byKey.get(key);
      return i ? { id: i.id, key: i.key, self: `${this.url}/rest/api/3/issue/${i.id}`, fields: { summary: i.summary, status: this.statusJson(view, i.status), issuetype: this.typeJson(view, i.type) } } : { key };
    };
    return view.links.filter((l) => l.inward === issue.key || l.outward === issue.key).map((l) => {
      const type = view.linkTypes.find((t) => t.name === l.type)!;
      const t = { id: type.id, name: type.name, inward: type.inward, outward: type.outward, self: `${this.url}/rest/api/3/issueLinkType/${type.id}` };
      // Seen from the blocked issue, the blocker is its inwardIssue ("is blocked by"); seen from the blocker, the blocked is its outwardIssue ("blocks").
      return l.inward === issue.key ? { id: l.id, type: t, inwardIssue: brief(l.outward) } : { id: l.id, type: t, outwardIssue: brief(l.inward) };
    });
  }

  private issueJson(view: View, i: SimIssue, wanted?: string[]) {
    const parent = i.parent ? view.byKey.get(i.parent) : undefined;
    const spent = i.worklogs.reduce((n, w) => n + w.timeSpentSeconds, 0);
    const all: Record<string, unknown> = {
      summary: i.summary, status: this.statusJson(view, i.status), issuetype: this.typeJson(view, i.type),
      project: { self: `${this.url}/rest/api/3/project/${view.project.id}`, ...view.project, projectTypeKey: 'software' },
      labels: i.labels, description: i.description, assignee: this.userJson(view, i.assignee), reporter: this.userJson(view, i.reporter), creator: this.userJson(view, i.reporter),
      created: i.created, updated: i.updated,
      resolution: i.resolution ? { self: `${this.url}/rest/api/3/resolution/${10000 + view.resolutions.indexOf(i.resolution)}`, id: String(10000 + view.resolutions.indexOf(i.resolution)), name: i.resolution, description: '' } : null,
      resolutiondate: i.resolutionDate ?? null,
      ...(parent ? { parent: { id: parent.id, key: parent.key, self: `${this.url}/rest/api/3/issue/${parent.id}`, fields: { summary: parent.summary, status: this.statusJson(view, parent.status), issuetype: this.typeJson(view, parent.type) } } } : {}),
      issuelinks: this.linksJson(view, i),
      comment: { comments: i.comments.map((c) => this.commentJson(view, i, c)), maxResults: i.comments.length, total: i.comments.length, startAt: 0 },
      worklog: { startAt: 0, maxResults: 20, total: i.worklogs.length, worklogs: i.worklogs.map((w) => this.worklogJson(view, i, w)) },
      timespent: spent || null, aggregatetimespent: spent || null,
      ...i.custom
    };
    const want = (wanted ?? ['*all']).map((f) => f.trim()).filter(Boolean);
    let fields: Record<string, unknown> = {};
    if (want.some((f) => f === '*all' || f === '*navigable')) {
      fields = { ...all };
    }
    for (const f of want) {
      if (f.startsWith('-')) { delete fields[f.slice(1)]; } else if (f in all) { fields[f] = all[f]; }
    }
    return { expand: 'renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations', id: i.id, self: `${this.url}/rest/api/3/issue/${i.id}`, key: i.key, fields };
  }

  // ---- dashboard ----

  private async dashboard(req: http.IncomingMessage, res: http.ServerResponse, url: URL, raw: string) {
    const p = url.pathname;
    const method = req.method ?? 'GET';
    if (p === '/' || p === '/index.html') {
      const file = this.opts.dashboardFile ?? path.join(__dirname, '..', '..', 'media', 'simulator.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }
    const browse = /^\/browse\/([\w-]+)$/.exec(p);
    if (browse) {
      res.writeHead(302, { Location: `/#issue=${browse[1].toUpperCase()}` });
      res.end();
      return;
    }
    if (p === '/_sim/ping') { return send(res, ok(await this.ping())); }
    if (p === '/_sim/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 1500\ndata: hello\n\n');
      this.listeners.add(res);
      req.on('close', () => this.listeners.delete(res));
      return;
    }
    if (!p.startsWith('/_sim/api/')) { return send(res, { status: 404, body: { error: 'Not found' } }); }
    let body: Record<string, any> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(res, { status: 400, body: { error: 'The body is not JSON.' } });
    }
    try {
      send(res, await this.dashboardApi(method, p.slice('/_sim/api'.length), body));
    } catch (e) {
      const message = e instanceof ApiError ? [...e.messages, ...Object.entries(e.errors).map(([k, v]) => `${k}: ${v}`)].join('; ') : String(e instanceof Error ? e.message : e);
      send(res, { status: e instanceof ApiError ? e.status : 500, body: { error: message } });
    }
  }

  /** How the extension recognises a simulator on the port: it answers at once, even when its storage does not. */
  private async ping() {
    const base = { id: SIM_ID, url: this.url, storage: this.storage.kind };
    try {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer from the ${this.storage.kind} storage`)), 500).unref());
      const summary = await Promise.race([this.summary(), timeout]);
      return { ...base, ...summary };
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** What the dashboard reads and does; its writes are made as the user it acts as, like changes made in Jira by someone else. */
  private async dashboardApi(method: string, p: string, b: Record<string, any>): Promise<Reply> {
    const ctx = await this.storage.context();
    const actor = ctx.users.some((u) => u.accountId === b.as) ? String(b.as) : ctx.me;
    let r: RegExpExecArray | null;
    if (p === '/state' && method === 'GET') {
      const [issues, links, faults, log] = await Promise.all([this.storage.issues(), this.storage.links(), this.storage.faults(), this.storage.log(300)]);
      return ok({
        url: this.url, project: ctx.project, statuses: ctx.statuses, issueTypes: ctx.issueTypes, resolutions: ctx.resolutions, linkTypes: ctx.linkTypes,
        users: ctx.users, me: ctx.me, links, settings: ctx.settings, faults, presets: FAULT_PRESETS,
        stateFile: this.storage.kind === 'file' ? this.storage.location : null, storage: { kind: this.storage.kind, location: this.storage.location ?? null },
        issues: issues.map((i) => ({ ...i, description: undefined, transitions: transitionsOf(ctx, i), category: statusOf(ctx, i.status).category })),
        log
      });
    }
    if ((r = /^\/log\/(\d+)$/.exec(p))) { return ok((await this.storage.logBodies(Number(r[1]))) ?? {}); }
    if (p === '/log/clear' && method === 'POST') { await this.storage.clearLog(); this.changed(); return ok({}); }
    if (p === '/reset' && method === 'POST') { await this.reset(); return ok({}); }
    if (p === '/export' && method === 'GET') { return { status: 200, body: await this.storage.exportState(), headers: { 'Content-Disposition': 'attachment; filename="jira-simulator-state.json"' } }; }
    if (p === '/import' && method === 'POST') {
      if (b.version !== 1 || !Array.isArray(b.issues)) { throw new ApiError(400, ['Not a simulator state (version 1 with issues).']); }
      await this.storage.replaceState({ ...seedState(), ...b, settings: { ...DEFAULT_SETTINGS, ...b.settings } } as SimState);
      this.changed();
      return ok({});
    }
    if (p === '/settings' && method === 'POST') {
      const next: Partial<SimSettings> = {};
      for (const [k, v] of Object.entries(b)) {
        if (!(k in DEFAULT_SETTINGS)) { continue; }
        const d = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
        (next as Record<string, unknown>)[k] = typeof d === 'number' ? Math.max(k === 'pageSize' ? 1 : 0, Number(v) || 0) : typeof d === 'boolean' ? !!v : v;
      }
      const settings = { ...ctx.settings, ...next };
      await this.storage.saveSettings(settings);
      this.changed();
      return ok(settings);
    }
    if (p === '/faults' && method === 'POST') {
      const base = b.preset ? FAULT_PRESETS[String(b.preset)] : b;
      if (!base) { throw new ApiError(400, [`No fault preset '${b.preset}'.`]); }
      const f: SimFault = {
        id: await this.storage.nextId(), label: String(base.label || `${base.method ?? '*'} ${base.path ?? ''} → ${base.kind === 'error' ? base.status : base.kind}`),
        method: String(base.method || '*').toUpperCase(), path: String(base.path ?? '/rest/'), kind: base.kind === 'drop' || base.kind === 'delay' ? base.kind : 'error',
        status: Number(base.status) || 500, message: String(base.message ?? ''), delayMs: Number(base.delayMs) || 0,
        remaining: base.remaining === undefined ? 1 : Number(base.remaining), hits: 0
      };
      await this.storage.addFault(f);
      this.changed();
      return ok(f);
    }
    if (p === '/faults' && method === 'DELETE') { await this.storage.clearFaults(); this.changed(); return ok({}); }
    if ((r = /^\/faults\/(\w+)$/.exec(p)) && method === 'DELETE') { await this.storage.deleteFault(r[1]); this.changed(); return ok({}); }
    if (p === '/issue' && method === 'POST') {
      const fields: Record<string, unknown> = { project: { key: ctx.project.key }, issuetype: { name: b.type || 'Task' }, summary: b.summary ?? '' };
      if (b.parent) { fields.parent = { key: b.parent }; }
      if (b.labels?.length) { fields.labels = b.labels; }
      if (b.description) { fields.description = textToAdf(String(b.description)); }
      if (b.assignee !== undefined) { fields.assignee = { accountId: b.assignee || null }; }
      return ok(await this.create(ctx, fields, actor));
    }
    if (p === '/link' && method === 'POST') { await this.link(ctx, { type: { name: 'Blocks' }, inwardIssue: { key: b.blocked }, outwardIssue: { key: b.blocker } }); return ok({}); }
    if ((r = /^\/link\/(\w+)$/.exec(p)) && method === 'DELETE') { await this.storage.deleteLink(r[1]); this.changed(); return ok({}); }
    if ((r = /^\/issue\/([\w-]+)(?:\/(\w+))?$/.exec(p))) {
      const issue = await this.issue(r[1]);
      switch (r[2]) {
        case undefined:
          if (method === 'GET') { return ok({ ...issue, json: this.issueJson(await this.view(ctx, [issue]), issue) }); }
          if (method === 'DELETE') { await this.remove(issue); return ok({}); }
          break;
        case 'transition': {
          const fields = b.resolution ? { resolution: { name: b.resolution } } : {};
          const update: Record<string, any[]> = {};
          if (b.timeSpent) { update.worklog = [{ add: { timeSpent: b.timeSpent } }]; }
          if (b.comment) { update.comment = [{ add: { body: textToAdf(String(b.comment)) } }]; }
          await this.transition(ctx, issue, String(b.id), fields, update, actor);
          return ok({});
        }
        case 'comment': await this.comment(issue, textToAdf(String(b.text ?? '')), actor); return ok({});
        case 'worklog': await this.worklog(issue, { timeSpent: String(b.timeSpent ?? '') }, actor); return ok({});
        case 'edit': {
          const fields: Record<string, unknown> = {};
          if (b.summary !== undefined) { fields.summary = b.summary; }
          if (b.labels !== undefined) { fields.labels = b.labels; }
          if (b.assignee !== undefined) { fields.assignee = { accountId: b.assignee || null }; }
          if (b.description !== undefined) { fields.description = b.description ? textToAdf(String(b.description)) : null; }
          await this.edit(ctx, issue, fields, {}, actor);
          return ok({});
        }
      }
    }
    throw new ApiError(404, [`No dashboard action ${method} ${p}.`]);
  }
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function send(res: http.ServerResponse, r: Reply) {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...r.headers };
  if (r.status === 204 || r.body === undefined) {
    res.writeHead(r.status, headers);
    res.end();
    return;
  }
  res.writeHead(r.status, { 'Content-Type': 'application/json;charset=UTF-8', ...headers });
  res.end(JSON.stringify(r.body));
}

function isAdf(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as { type?: string }).type === 'doc' && Array.isArray((v as { content?: unknown }).content);
}

function show(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}
