// The simulator's state in MongoDB: one collection per entity, one write per operation, atomic counters.
// Only the CLI loads this file (`--mongo <uri>` or MONGODB_URI): nothing else in this repo needs the mongodb driver.
//
//   projects     { _id: project id, key, name }                                      unique key
//   metadata     { _id: 'workflow', statuses, issueTypes, resolutions, linkTypes }
//                { _id: 'settings', ...SimSettings }
//                { _id: 'instance', version, me, project, writtenAt }                written last: no instance, no state
//   users        { _id: accountId, seq, displayName, emailAddress }
//   issues       { _id: id, seq, project, key, type, summary, status, parent, ... }  unique key; project+seq; parent
//   comments     { _id: id, seq, issueId, author, body, text, created, updated }     issueId+seq
//   worklogs     { _id: id, seq, issueId, author, timeSpent, timeSpentSeconds, ... } issueId+seq
//   changelog    { issueId, at, author, field, from, to }                            issueId+at
//   links        { _id: id, seq, type, inward, outward }                             inward; outward; unique type+inward+outward
//   faults       { _id: id, seq, label, method, path, kind, status, ... }
//   counters     { _id: 'id' | 'issue:<project key>' | 'requestLog', seq }           seq is the last value handed out
//   requestLog   { _id: n, at, method, path, status, ms, user, fault, error, request, response }
//
// seq is the numeric id, so documents sort in creation order like the arrays of the JSON state.
import { Collection, Db, Document, Filter, MongoClient, MongoServerError } from 'mongodb';
import { DEFAULT_PROJECT, seedState } from './seed';
import { IssueQuery, LOG_SIZE, LogBodies, SimContext, SimStorage } from './storage';
import {
  DEFAULT_SETTINGS, IssueCore, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink, SimSettings, SimState, SimUser, SimWorklog
} from './types';

export const DEFAULT_DB = 'devfactory-sim';

type IssueDoc = Omit<IssueCore, 'id'> & { _id: string; seq: number; project: string };
type CommentDoc = Omit<SimComment, 'id'> & { _id: string; seq: number; issueId: string };
type WorklogDoc = Omit<SimWorklog, 'id'> & { _id: string; seq: number; issueId: string };
type ChangeDoc = SimChange & { issueId: string };
type LinkDoc = Omit<SimLink, 'id'> & { _id: string; seq: number };
type FaultDoc = Omit<SimFault, 'id'> & { _id: string; seq: number };
type UserDoc = Omit<SimUser, 'accountId'> & { _id: string; seq: number };
type ProjectDoc = Omit<SimState['project'], 'id'> & { _id: string };
type CounterDoc = { _id: string; seq: number };
type LogDoc = Omit<LogEntry, 'id'> & LogBodies & { _id: number };
/** The documents of `metadata`, told apart by their _id. */
type MetaDoc = { _id: string } & Document;
type WorkflowDoc = Pick<SimState, 'statuses' | 'issueTypes' | 'resolutions' | 'linkTypes'>;
type InstanceDoc = { version: 1; me: string; project: string; writtenAt: string };

/** The database named in the URI's path, e.g. mongodb://mongo:27017/devfactory-sim. */
export function dbNameOf(uri: string): string | undefined {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(uri);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** The URI without its credentials, for logs and the dashboard. */
export function redactUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]+@/, '$1***@');
}

export class MongoStorage implements SimStorage {
  readonly kind = 'mongodb';
  readonly location: string;
  private readonly client: MongoClient;
  private readonly dbName: string;
  private db!: Db;
  /** The project the issues are read from; set when the state is opened or replaced. */
  private projectKey = '';
  private seeding?: Promise<void>;

  constructor(uri: string, private readonly project: string = DEFAULT_PROJECT, dbName?: string) {
    this.dbName = dbName ?? dbNameOf(uri) ?? DEFAULT_DB;
    const where = redactUri(uri).replace(/\?.*$/, '');
    this.location = dbNameOf(uri) ? where : `${where.replace(/\/$/, '')}/${this.dbName}`;
    this.client = new MongoClient(uri, { ignoreUndefined: true, serverSelectionTimeoutMS: 5000, appName: 'devfactory-simulator' });
  }

  private get projects() { return this.db.collection<ProjectDoc>('projects'); }
  private get metadata() { return this.db.collection<MetaDoc>('metadata'); }
  private get users() { return this.db.collection<UserDoc>('users'); }
  private get issueDocs() { return this.db.collection<IssueDoc>('issues'); }
  private get comments() { return this.db.collection<CommentDoc>('comments'); }
  private get worklogs() { return this.db.collection<WorklogDoc>('worklogs'); }
  private get changelog() { return this.db.collection<ChangeDoc>('changelog'); }
  private get linkDocs() { return this.db.collection<LinkDoc>('links'); }
  private get faultDocs() { return this.db.collection<FaultDoc>('faults'); }
  private get counters() { return this.db.collection<CounterDoc>('counters'); }
  private get requestLog() { return this.db.collection<LogDoc>('requestLog'); }

  async open() {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    await Promise.all([
      this.projects.createIndex({ key: 1 }, { unique: true }),
      this.issueDocs.createIndex({ key: 1 }, { unique: true }),
      this.issueDocs.createIndex({ project: 1, seq: 1 }),
      this.issueDocs.createIndex({ parent: 1 }),
      this.comments.createIndex({ issueId: 1, seq: 1 }),
      this.worklogs.createIndex({ issueId: 1, seq: 1 }),
      this.changelog.createIndex({ issueId: 1, at: 1 }),
      this.linkDocs.createIndex({ inward: 1 }),
      this.linkDocs.createIndex({ outward: 1 }),
      this.linkDocs.createIndex({ type: 1, inward: 1, outward: 1 }, { unique: true }),
      this.users.createIndex({ emailAddress: 1 })
    ]);
    await this.seedIfEmpty();
  }

  async close() {
    await this.client.close();
  }

  /** Seeds an empty database, or one whose state was cut short or deleted (e.g. from Compass); once at a time. */
  private seedIfEmpty(): Promise<void> {
    this.seeding ??= (async () => {
      const instance = await this.metadata.findOne({ _id: 'instance' }) as (InstanceDoc & MetaDoc) | null;
      if (instance && await this.metadata.countDocuments({ _id: 'workflow' }) && await this.projects.countDocuments({ key: instance.project })) {
        this.projectKey = instance.project;
      } else {
        await this.replaceState(seedState(this.project));
      }
    })().finally(() => { this.seeding = undefined; });
    return this.seeding;
  }

  private async next(counter: string): Promise<number> {
    const doc = await this.counters.findOneAndUpdate({ _id: counter }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return doc!.seq;
  }

  async context(retry = true): Promise<SimContext> {
    const [meta, users, project] = await Promise.all([
      this.metadata.find().toArray(),
      this.users.find().sort({ seq: 1 }).toArray(),
      this.projects.findOne({ key: this.projectKey })
    ]);
    const doc = <T>(id: string) => meta.find((d) => d._id === id) as (T & MetaDoc) | undefined;
    const workflow = doc<WorkflowDoc>('workflow');
    const instance = doc<InstanceDoc>('instance');
    if (!workflow || !instance || !project) {
      if (!retry) { throw new Error(`The MongoDB database ${this.dbName} has no simulator state.`); }
      await this.seedIfEmpty();
      return this.context(false);
    }
    const { _id, ...settings } = doc<Partial<SimSettings>>('settings') ?? { _id: 'settings' };
    return {
      project: { id: project._id, key: project.key, name: project.name },
      statuses: workflow.statuses, issueTypes: workflow.issueTypes, resolutions: workflow.resolutions, linkTypes: workflow.linkTypes,
      users: users.map((u) => ({ accountId: u._id, displayName: u.displayName, emailAddress: u.emailAddress })),
      me: instance.me,
      settings: { ...DEFAULT_SETTINGS, ...settings }
    };
  }

  async updateUser(accountId: string, patch: Partial<Omit<SimUser, 'accountId'>>) {
    await this.users.updateOne({ _id: accountId }, { $set: patch });
  }

  async saveSettings(settings: SimSettings) {
    await this.metadata.replaceOne({ _id: 'settings' }, { _id: 'settings', ...settings }, { upsert: true });
  }

  async nextId() {
    return String(await this.next('id'));
  }

  async nextIssueNumber() {
    return this.next(`issue:${this.projectKey}`);
  }

  private findIssues(q?: IssueQuery) {
    const filter: Filter<IssueDoc> = { project: this.projectKey };
    // Jira keys are upper case: a key given in any case is found by its upper-case form, on the unique index.
    if (q?.refs) { filter.$or = [{ key: { $in: q.refs.map((r) => r.toUpperCase()) } }, { _id: { $in: q.refs } }]; }
    if (q?.parent !== undefined) { filter.parent = q.parent; }
    return this.issueDocs.find(filter).sort({ seq: 1 }).toArray();
  }

  private toCore({ _id, seq, project, ...rest }: IssueDoc): IssueCore {
    return { id: _id, ...rest };
  }

  async issues(q?: IssueQuery, opts: { history?: boolean } = {}): Promise<SimIssue[]> {
    const docs = await this.findIssues(q);
    if (!docs.length) { return []; }
    const of = { issueId: { $in: docs.map((d) => d._id) } };
    const [comments, worklogs, history] = await Promise.all([
      this.comments.find(of).sort({ seq: 1 }).toArray(),
      this.worklogs.find(of).sort({ seq: 1 }).toArray(),
      opts.history === false ? [] : this.changelog.find(of).sort({ at: 1, _id: 1 }).toArray()
    ]);
    const group = <T extends { issueId: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) { m.set(r.issueId, [...(m.get(r.issueId) ?? []), r]); }
      return m;
    };
    const [c, w, h] = [group(comments), group(worklogs), group(history)];
    return docs.map((d) => ({
      ...this.toCore(d),
      comments: (c.get(d._id) ?? []).map(({ _id, seq, issueId, ...rest }) => ({ id: _id, ...rest })),
      worklogs: (w.get(d._id) ?? []).map(({ _id, seq, issueId, ...rest }) => ({ id: _id, ...rest })),
      history: (h.get(d._id) ?? []).map(({ _id, issueId, ...rest }) => rest)
    }));
  }

  async briefs(q?: IssueQuery) {
    return (await this.findIssues(q)).map((d) => this.toCore(d));
  }

  async countIssues() {
    return this.issueDocs.countDocuments({ project: this.projectKey });
  }

  private issueDoc(i: IssueCore, project: string): IssueDoc {
    const { id, ...rest } = i;
    return { _id: id, seq: Number(id), project, ...rest };
  }

  async insertIssue(issue: SimIssue) {
    await this.insertIssues([issue], this.projectKey);
  }

  /** Issues with their comments, worklogs and history, a collection at a time. */
  private async insertIssues(issues: SimIssue[], project: string) {
    if (!issues.length) { return; }
    await this.issueDocs.insertMany(issues.map(({ comments, worklogs, history, ...i }) => this.issueDoc(i, project)));
    const comments = issues.flatMap((i) => i.comments.map(({ id, ...c }) => ({ _id: id, seq: Number(id), issueId: i.id, ...c })));
    const worklogs = issues.flatMap((i) => i.worklogs.map(({ id, ...w }) => ({ _id: id, seq: Number(id), issueId: i.id, ...w })));
    const history = issues.flatMap((i) => i.history.map((h) => ({ issueId: i.id, ...h })));
    await Promise.all([
      comments.length && this.comments.insertMany(comments),
      worklogs.length && this.worklogs.insertMany(worklogs),
      history.length && this.changelog.insertMany(history)
    ]);
  }

  async updateIssue(id: string, patch: Partial<IssueCore>, changes: SimChange[] = []) {
    const $set: Document = {};
    const $unset: Document = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id') { continue; }
      if (v === undefined) { $unset[k] = ''; } else { $set[k] = v; }
    }
    if (Object.keys($set).length || Object.keys($unset).length) {
      await this.issueDocs.updateOne({ _id: id }, { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}) });
    }
    if (changes.length) { await this.changelog.insertMany(changes.map((c) => ({ issueId: id, ...c }))); }
  }

  async deleteIssue(issue: IssueCore) {
    // No transaction (that needs a replica set): the issue goes first, so what may stay behind is never shown.
    await this.issueDocs.deleteOne({ _id: issue.id });
    await Promise.all([
      this.comments.deleteMany({ issueId: issue.id }),
      this.worklogs.deleteMany({ issueId: issue.id }),
      this.changelog.deleteMany({ issueId: issue.id }),
      this.linkDocs.deleteMany({ $or: [{ inward: issue.key }, { outward: issue.key }] })
    ]);
  }

  async addComment(issueId: string, { id, ...c }: SimComment) {
    await this.comments.insertOne({ _id: id, seq: Number(id), issueId, ...c });
  }

  async addWorklog(issueId: string, { id, ...w }: SimWorklog) {
    await this.worklogs.insertOne({ _id: id, seq: Number(id), issueId, ...w });
  }

  async links(keys?: string[]) {
    const filter: Filter<LinkDoc> = keys ? { $or: [{ inward: { $in: keys } }, { outward: { $in: keys } }] } : {};
    return (await this.linkDocs.find(filter).sort({ seq: 1 }).toArray()).map(({ _id, seq, ...l }) => ({ id: _id, ...l }));
  }

  async addLink({ id, ...l }: SimLink) {
    try {
      await this.linkDocs.insertOne({ _id: id, seq: Number(id), ...l });
      return true;
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) { return false; }
      throw e;
    }
  }

  async deleteLink(id: string) {
    return (await this.linkDocs.deleteOne({ _id: id })).deletedCount === 1;
  }

  async faults() {
    return (await this.faultDocs.find().sort({ seq: 1 }).toArray()).map(({ _id, seq, ...f }) => ({ id: _id, ...f }));
  }

  async addFault({ id, ...f }: SimFault) {
    await this.faultDocs.insertOne({ _id: id, seq: Number(id), ...f });
  }

  async hitFault(fault: SimFault) {
    if (fault.remaining < 0) {
      return (await this.faultDocs.updateOne({ _id: fault.id }, { $inc: { hits: 1 } })).matchedCount === 1;
    }
    // Only while some remain, so concurrent requests cannot use a "once" fault twice.
    const doc = await this.faultDocs.findOneAndUpdate({ _id: fault.id, remaining: { $gt: 0 } }, { $inc: { hits: 1, remaining: -1 } }, { returnDocument: 'after' });
    if (!doc) { return false; }
    if (doc.remaining === 0) { await this.faultDocs.deleteOne({ _id: fault.id, remaining: 0 }); }
    return true;
  }

  async deleteFault(id: string) {
    await this.faultDocs.deleteOne({ _id: id });
  }

  async clearFaults() {
    await this.faultDocs.deleteMany({});
  }

  async addLog(entry: Omit<LogEntry, 'id'>, bodies: LogBodies) {
    const id = await this.next('requestLog');
    try {
      await this.requestLog.insertOne({ _id: id, ...entry, ...bodies });
    } catch (e) {
      // A body BSON cannot hold (too large, odd keys): keep the call without it.
      await this.requestLog.insertOne({ _id: id, ...entry, response: `Body not kept: ${e instanceof Error ? e.message : e}` });
    }
    if (id % 25 === 0) { await this.requestLog.deleteMany({ _id: { $lte: id - LOG_SIZE } }); }
    return id;
  }

  async log(limit: number) {
    const docs = await this.requestLog.find({}, { projection: { request: 0, response: 0 } }).sort({ _id: -1 }).limit(limit).toArray();
    return docs.reverse().map(({ _id, ...e }) => ({ id: _id, ...e }));
  }

  async logBodies(id: number) {
    const doc = await this.requestLog.findOne({ _id: id }, { projection: { request: 1, response: 1 } });
    return doc ? { request: doc.request, response: doc.response } : undefined;
  }

  async clearLog() {
    await this.requestLog.deleteMany({});
  }

  async exportState(): Promise<SimState> {
    const ctx = await this.context();
    const [issues, links, faults, counters] = await Promise.all([
      this.issues(), this.links(), this.faults(), this.counters.find({ _id: { $in: ['id', `issue:${this.projectKey}`] } }).toArray()
    ]);
    const last = (id: string) => counters.find((c) => c._id === id)?.seq ?? 0;
    return {
      version: 1, project: ctx.project, statuses: ctx.statuses, issueTypes: ctx.issueTypes, resolutions: ctx.resolutions, linkTypes: ctx.linkTypes,
      users: ctx.users, me: ctx.me, nextId: last('id') + 1, nextNumber: last(`issue:${this.projectKey}`) + 1, issues, links, settings: ctx.settings, faults
    };
  }

  async replaceState(s: SimState) {
    // The instance document goes first and comes back last: a replacement cut short is seeded again on the next start.
    await this.metadata.deleteOne({ _id: 'instance' });
    const all: Collection<any>[] = [this.projects, this.users, this.issueDocs, this.comments, this.worklogs, this.changelog, this.linkDocs, this.faultDocs];
    await Promise.all([
      ...all.map((c) => c.deleteMany({})),
      this.metadata.deleteMany({}),
      this.counters.deleteMany({ _id: { $ne: 'requestLog' } })
    ]);
    const project = s.project.key;
    await Promise.all([
      this.projects.insertOne({ _id: s.project.id, key: project, name: s.project.name }),
      this.metadata.insertMany([
        { _id: 'workflow', statuses: s.statuses, issueTypes: s.issueTypes, resolutions: s.resolutions, linkTypes: s.linkTypes },
        { _id: 'settings', ...DEFAULT_SETTINGS, ...s.settings }
      ]),
      s.users.length && this.users.insertMany(s.users.map(({ accountId, ...u }, n) => ({ _id: accountId, seq: n, ...u }))),
      this.insertIssues(s.issues, project),
      s.links.length && this.linkDocs.insertMany(s.links.map(({ id, ...l }) => ({ _id: id, seq: Number(id), ...l })), { ordered: false }).catch((e) => {
        if (!(e instanceof MongoServerError && e.code === 11000)) { throw e; }
      }),
      s.faults.length && this.faultDocs.insertMany(s.faults.map(({ id, ...f }) => ({ _id: id, seq: Number(id), ...f }))),
      this.counters.insertMany([{ _id: 'id', seq: s.nextId - 1 }, { _id: `issue:${project}`, seq: s.nextNumber - 1 }])
    ]);
    this.projectKey = project;
    await this.metadata.insertOne({ _id: 'instance', version: 1, me: s.me, project, writtenAt: new Date().toISOString() });
  }
}
