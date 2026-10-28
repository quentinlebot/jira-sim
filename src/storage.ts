// Where the simulator keeps its state. The server only goes through SimStorage, one call per read or write, so the
// backend can be a JSON file (or memory), as with `jira-sim --state <file>`, or MongoDB (mongoStorage.ts) or
// PostgreSQL (postgresStorage.ts), which only the CLI loads: nothing else in this repo needs those drivers.
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_PROJECT, seedState } from './seed';
import {
  DEFAULT_SETTINGS, IssueCore, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink, SimSettings, SimState, SimUser, SimWorklog
} from './types';

/** What every request works with: the project, its workflow metadata, the users and the settings. */
export type SimContext = Pick<SimState, 'project' | 'statuses' | 'issueTypes' | 'resolutions' | 'linkTypes' | 'users' | 'me' | 'settings'>;

export interface IssueQuery {
  /** Issue keys, in any case, or ids. */
  refs?: string[];
  /** The child issues of this key. */
  parent?: string;
}

/** The request and response bodies of a logged call. */
export interface LogBodies { request?: unknown; response?: unknown }

/** The most calls the request log keeps. */
export const LOG_SIZE = 500;

export interface SimStorage {
  readonly kind: 'memory' | 'file' | 'mongodb' | 'postgres';
  /** The file, or the MongoDB or PostgreSQL server and database (without credentials); undefined in memory. */
  readonly location?: string;
  /** Loads the state, or seeds it when there is none yet. */
  open(): Promise<void>;
  /** Writes what is pending and lets go of the file or the connection. */
  close(): Promise<void>;

  context(): Promise<SimContext>;
  updateUser(accountId: string, patch: Partial<Omit<SimUser, 'accountId'>>): Promise<void>;
  saveSettings(settings: SimSettings): Promise<void>;

  /** A new id for an issue, comment, worklog, link or fault. Atomic. */
  nextId(): Promise<string>;
  /** A new issue number of the project, for its key. Atomic. */
  nextIssueNumber(): Promise<number>;

  /** Issues with their comments, worklogs and (unless `history` is false) history, in creation order; all without a query. */
  issues(q?: IssueQuery, opts?: { history?: boolean }): Promise<SimIssue[]>;
  /** Issues without their comments, worklogs and history. */
  briefs(q?: IssueQuery): Promise<IssueCore[]>;
  countIssues(): Promise<number>;
  insertIssue(issue: SimIssue): Promise<void>;
  /** Sets the fields of the patch (undefined removes one) and appends the changes to the issue's history. */
  updateIssue(id: string, patch: Partial<IssueCore>, changes?: SimChange[]): Promise<void>;
  /** Deletes the issue with its comments, worklogs, history and links. */
  deleteIssue(issue: IssueCore): Promise<void>;
  addComment(issueId: string, comment: SimComment): Promise<void>;
  addWorklog(issueId: string, worklog: SimWorklog): Promise<void>;

  /** All links, or those of these issue keys. */
  links(keys?: string[]): Promise<SimLink[]>;
  /** False when the same link (type, inward, outward) already exists. */
  addLink(link: SimLink): Promise<boolean>;
  deleteLink(id: string): Promise<boolean>;

  faults(): Promise<SimFault[]>;
  addFault(fault: SimFault): Promise<void>;
  /** Counts a hit of the fault and uses up one of its remaining requests; false when it is already used up. */
  hitFault(fault: SimFault): Promise<boolean>;
  deleteFault(id: string): Promise<void>;
  clearFaults(): Promise<void>;

  /** Logs a call and returns its id; the log keeps the last LOG_SIZE calls. */
  addLog(entry: Omit<LogEntry, 'id'>, bodies: LogBodies): Promise<number>;
  /** The last calls, oldest first. */
  log(limit: number): Promise<LogEntry[]>;
  logBodies(id: number): Promise<LogBodies | undefined>;
  clearLog(): Promise<void>;

  /** The whole state, as the dashboard exports it. */
  exportState(): Promise<SimState>;
  /** Replaces the whole state (reset, import); the request log stays. */
  replaceState(state: SimState): Promise<void>;
}

/** Display form of a storage, for the CLI and the dashboard. */
export function describeStorage(s: SimStorage): string {
  return s.kind === 'memory' ? 'in memory' : s.kind === 'file' ? `in ${s.location}` : s.kind === 'mongodb' ? `in MongoDB ${s.location}` : `in PostgreSQL ${s.location}`;
}

const clone = <T>(v: T): T => structuredClone(v);

const matches = (i: IssueCore, q?: IssueQuery) =>
  (!q?.refs || q.refs.some((r) => i.key.toLowerCase() === r.toLowerCase() || i.id === r)) && (q?.parent === undefined || i.parent === q.parent);

const core = ({ comments, worklogs, history, ...rest }: SimIssue): IssueCore => rest;

/**
 * The state in memory, written to a JSON file (when there is one) a moment after each change.
 * Every read returns a copy, so the server changes the state only through these calls, as with MongoDB.
 */
export class FileStorage implements SimStorage {
  readonly kind: 'memory' | 'file';
  private state!: SimState;
  private readonly entries: LogEntry[] = [];
  private readonly bodies = new Map<number, LogBodies>();
  private logId = 0;
  private saveTimer?: NodeJS.Timeout;

  constructor(readonly location?: string, private readonly project: string = DEFAULT_PROJECT) {
    this.kind = location ? 'file' : 'memory';
  }

  async open() {
    this.state = this.load();
  }

  async close() {
    this.flush();
  }

  private load(): SimState {
    const file = this.location;
    if (file && fs.existsSync(file)) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8')) as SimState;
        if (s.version === 1 && Array.isArray(s.issues)) {
          s.settings = { ...DEFAULT_SETTINGS, ...s.settings };
          s.faults ??= [];
          return s;
        }
      } catch {
        fs.copyFileSync(file, `${file}.broken`);
      }
    }
    return seedState(this.project);
  }

  private changed() {
    if (this.location) {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flush(), 250);
    }
  }

  private flush() {
    const file = this.location;
    if (!file || !this.saveTimer) { return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.state));
    fs.renameSync(`${file}.tmp`, file);
  }

  private issue(id: string) {
    return this.state.issues.find((i) => i.id === id);
  }

  async context(): Promise<SimContext> {
    const { project, statuses, issueTypes, resolutions, linkTypes, users, me, settings } = this.state;
    return clone({ project, statuses, issueTypes, resolutions, linkTypes, users, me, settings });
  }

  async updateUser(accountId: string, patch: Partial<Omit<SimUser, 'accountId'>>) {
    const u = this.state.users.find((x) => x.accountId === accountId);
    if (u) { Object.assign(u, patch); this.changed(); }
  }

  async saveSettings(settings: SimSettings) {
    this.state.settings = clone(settings);
    this.changed();
  }

  async nextId() {
    this.changed();
    return String(this.state.nextId++);
  }

  async nextIssueNumber() {
    this.changed();
    return this.state.nextNumber++;
  }

  async issues(q?: IssueQuery, opts: { history?: boolean } = {}) {
    return this.state.issues.filter((i) => matches(i, q)).map((i) => clone(opts.history === false ? { ...i, history: [] } : i));
  }

  async briefs(q?: IssueQuery) {
    return this.state.issues.filter((i) => matches(i, q)).map((i) => clone(core(i)));
  }

  async countIssues() {
    return this.state.issues.length;
  }

  async insertIssue(issue: SimIssue) {
    this.state.issues.push(clone(issue));
    this.changed();
  }

  async updateIssue(id: string, patch: Partial<IssueCore>, changes: SimChange[] = []) {
    const issue = this.issue(id);
    if (!issue) { return; }
    for (const [k, v] of Object.entries(clone(patch))) {
      if (k === 'id') { continue; }
      if (v === undefined) { delete (issue as unknown as Record<string, unknown>)[k]; } else { (issue as unknown as Record<string, unknown>)[k] = v; }
    }
    issue.history.push(...clone(changes));
    this.changed();
  }

  async deleteIssue(issue: IssueCore) {
    this.state.issues = this.state.issues.filter((i) => i.id !== issue.id);
    this.state.links = this.state.links.filter((l) => l.inward !== issue.key && l.outward !== issue.key);
    this.changed();
  }

  async addComment(issueId: string, comment: SimComment) {
    this.issue(issueId)?.comments.push(clone(comment));
    this.changed();
  }

  async addWorklog(issueId: string, worklog: SimWorklog) {
    this.issue(issueId)?.worklogs.push(clone(worklog));
    this.changed();
  }

  async links(keys?: string[]) {
    return clone(keys ? this.state.links.filter((l) => keys.includes(l.inward) || keys.includes(l.outward)) : this.state.links);
  }

  async addLink(link: SimLink) {
    if (this.state.links.some((l) => l.type === link.type && l.inward === link.inward && l.outward === link.outward)) { return false; }
    this.state.links.push(clone(link));
    this.changed();
    return true;
  }

  async deleteLink(id: string) {
    const before = this.state.links.length;
    this.state.links = this.state.links.filter((l) => l.id !== id);
    this.changed();
    return this.state.links.length < before;
  }

  async faults() {
    return clone(this.state.faults);
  }

  async addFault(fault: SimFault) {
    this.state.faults.push(clone(fault));
    this.changed();
  }

  async hitFault(fault: SimFault) {
    const f = this.state.faults.find((x) => x.id === fault.id);
    if (!f || f.remaining === 0) { return false; }
    f.hits++;
    if (f.remaining > 0) { f.remaining--; }
    if (f.remaining === 0) { this.state.faults = this.state.faults.filter((x) => x !== f); }
    this.changed();
    return true;
  }

  async deleteFault(id: string) {
    this.state.faults = this.state.faults.filter((f) => f.id !== id);
    this.changed();
  }

  async clearFaults() {
    this.state.faults = [];
    this.changed();
  }

  async addLog(entry: Omit<LogEntry, 'id'>, bodies: LogBodies) {
    const id = ++this.logId;
    this.entries.push({ id, ...entry });
    this.bodies.set(id, bodies);
    while (this.entries.length > LOG_SIZE) { this.bodies.delete(this.entries.shift()!.id); }
    return id;
  }

  async log(limit: number) {
    return clone(this.entries.slice(-limit));
  }

  async logBodies(id: number) {
    return this.bodies.get(id);
  }

  async clearLog() {
    this.entries.length = 0;
    this.bodies.clear();
  }

  async exportState() {
    return clone(this.state);
  }

  async replaceState(state: SimState) {
    this.state = clone(state);
    this.changed();
  }
}
