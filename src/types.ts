// State of the Jira simulator: one project, its issues and links, the seeded epic, task and decision workflows, the simulated validators and faults.

export interface SimUser { accountId: string; displayName: string; emailAddress: string }

export interface SimComment { id: string; author: string; body: unknown; text: string; created: string; updated: string }

export interface SimWorklog { id: string; author: string; timeSpent: string; timeSpentSeconds: number; started: string; created: string }

export interface SimChange { at: string; author: string; field: string; from?: string; to?: string }

export interface SimIssue {
  id: string;
  key: string;
  type: string;
  summary: string;
  /** ADF, as Jira stores it, and its plain text for search. */
  description: unknown | null;
  descriptionText?: string;
  labels: string[];
  status: string;
  resolution: string | null;
  resolutionDate?: string | null;
  parent?: string;
  assignee: string | null;
  reporter: string;
  created: string;
  updated: string;
  comments: SimComment[];
  worklogs: SimWorklog[];
  history: SimChange[];
  custom: Record<string, unknown>;
}

/** An issue without its comments, worklogs and history: enough for a parent, a linked issue or a child. */
export type IssueCore = Omit<SimIssue, 'comments' | 'worklogs' | 'history'>;

/** `blocker` blocks `blocked`; on the blocked issue Jira shows it as "is blocked by" with the blocker as inwardIssue. */
export interface SimLink { id: string; type: string; outward: string; inward: string }

export interface SimStatus { id: string; name: string; category: 'new' | 'indeterminate' | 'done' }

export interface SimTransition {
  id: string;
  name: string;
  from: string | '*';
  to: string;
  /** Set by the transition itself, as a Jira post-function would: a Decision's outcome. */
  resolution?: string;
  /** The transition is refused without a comment. */
  needsComment?: boolean;
}

export interface SimSettings {
  /** conventions: the epic and task workflows of jira-workflow-conventions.md. free: any status to any status. */
  workflow: 'conventions' | 'free';
  resolutionRequired: boolean;
  worklogRequired: boolean;
  reviewNeedsTasksDone: boolean;
  epicNameRequired: boolean;
  /** The most issues one search page returns, whatever maxResults asks. Lower it to exercise paging. */
  pageSize: number;
  latencyMs: number;
  newIssueAssignee: 'unassigned' | 'reporter';
}

export interface SimFault {
  id: string;
  label: string;
  method: string;
  /** Matches when the request path contains it. */
  path: string;
  kind: 'error' | 'drop' | 'delay';
  status: number;
  message: string;
  delayMs: number;
  /** Requests it still applies to; -1 until removed. */
  remaining: number;
  hits: number;
}

export interface SimState {
  version: 1;
  project: { id: string; key: string; name: string };
  statuses: SimStatus[];
  issueTypes: { id: string; name: string; hierarchyLevel: number }[];
  resolutions: string[];
  linkTypes: { id: string; name: string; inward: string; outward: string }[];
  users: SimUser[];
  /** The account every API call is made as, whatever its credentials. */
  me: string;
  nextId: number;
  nextNumber: number;
  issues: SimIssue[];
  links: SimLink[];
  settings: SimSettings;
  faults: SimFault[];
}

/** One REST call of a client, as the dashboard's Requests tab shows it. */
export interface LogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  user?: string;
  fault?: string;
  error?: string;
}

export const STATUS_CATEGORIES = {
  new: { id: 2, key: 'new', name: 'To Do', colorName: 'blue-gray' },
  indeterminate: { id: 4, key: 'indeterminate', name: 'In Progress', colorName: 'yellow' },
  done: { id: 3, key: 'done', name: 'Done', colorName: 'green' }
} as const;

export const STATUSES: SimStatus[] = [
  { id: '1', name: 'Open', category: 'new' },
  { id: '10001', name: 'Accepted', category: 'new' },
  { id: '10002', name: 'Ready', category: 'new' },
  { id: '3', name: 'In Progress', category: 'indeterminate' },
  { id: '10003', name: 'In Review', category: 'indeterminate' },
  { id: '10004', name: 'On Hold', category: 'indeterminate' },
  { id: '10005', name: 'Done', category: 'done' }
];

/** Epic states of jira-workflow-conventions.md. */
export const EPIC_FLOW: SimTransition[] = [
  { id: '11', name: 'Accept', from: 'Open', to: 'Accepted' },
  { id: '21', name: 'Mark ready', from: 'Accepted', to: 'Ready' },
  { id: '31', name: 'Start', from: 'Ready', to: 'In Progress' },
  { id: '41', name: 'Ask review', from: 'In Progress', to: 'In Review' },
  { id: '51', name: 'Close', from: 'In Review', to: 'Done' },
  { id: '61', name: 'Put on hold', from: 'In Progress', to: 'On Hold' },
  { id: '71', name: 'Resume', from: 'On Hold', to: 'In Progress' }
];

/** Task states of jira-workflow-conventions.md. */
export const TASK_FLOW: SimTransition[] = [
  { id: '11', name: 'Accept', from: 'Open', to: 'Accepted' },
  { id: '21', name: 'Mark ready', from: 'Accepted', to: 'Ready' },
  { id: '31', name: 'Start', from: 'Ready', to: 'In Progress' },
  { id: '51', name: 'Done', from: 'In Progress', to: 'Done' },
  { id: '61', name: 'Put on hold', from: 'In Progress', to: 'On Hold' },
  { id: '71', name: 'Resume', from: 'On Hold', to: 'In Progress' },
  { id: '81', name: "Won't Do", from: 'Open', to: 'Done' }
];

/** The issue type agents ask you a decision with. */
export const DECISION = 'Decision';

/** A Decision goes from Open to Done once: the transition taken is the outcome, and its resolution is what agents read. */
export const DECISION_FLOW: SimTransition[] = [
  { id: '91', name: 'Approve', from: 'Open', to: 'Done', resolution: 'Approved' },
  { id: '92', name: 'Reject', from: 'Open', to: 'Done', resolution: 'Rejected' },
  { id: '93', name: 'Answer', from: 'Open', to: 'Done', resolution: 'Answered', needsComment: true },
  { id: '94', name: 'Withdraw', from: 'Open', to: 'Done', resolution: 'Cancelled' }
];

export const RESOLUTIONS = ['Done', 'Resolved', 'Approved', 'Rejected', "Won't Do", 'Duplicate', 'Invalid', 'Cannot Reproduce', 'Declined', 'Cancelled', 'Abandoned', 'Answered'];

export const DEFAULT_SETTINGS: SimSettings = {
  workflow: 'conventions',
  resolutionRequired: true,
  worklogRequired: true,
  reviewNeedsTasksDone: false,
  epicNameRequired: false,
  pageSize: 50,
  latencyMs: 150,
  // Every call is made as the simulated you, so what you create is yours: a client's "my issues" finds it.
  newIssueAssignee: 'reporter'
};

export function statusOf(state: Pick<SimState, 'statuses'>, name: string): SimStatus {
  return state.statuses.find((s) => s.name === name) ?? state.statuses[0];
}

/** The transitions available from the issue's status, in the configured workflow. */
export function transitionsOf(state: Pick<SimState, 'statuses' | 'settings'>, issue: Pick<SimIssue, 'type' | 'status'>): SimTransition[] {
  // A Decision keeps its own flow whatever the setting: the free workflow is for epics and tasks.
  if (issue.type === DECISION) { return DECISION_FLOW.filter((t) => t.from === issue.status); }
  if (state.settings.workflow === 'free') {
    return state.statuses.filter((s) => s.name !== issue.status).map((s) => ({ id: String(101 + state.statuses.indexOf(s)), name: s.name, from: '*', to: s.name }));
  }
  return (issue.type === 'Epic' ? EPIC_FLOW : TASK_FLOW).filter((t) => t.from === issue.status);
}

/** "1w 2d 3h 30m" in seconds, with Jira's defaults of 5 days a week and 8 hours a day; undefined when invalid. */
export function durationSeconds(text: string): number | undefined {
  const t = text.trim();
  if (!/^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(t)) { return undefined; }
  const unit: Record<string, number> = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };
  return Math.round([...t.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/gi)].reduce((s, m) => s + Number(m[1]) * unit[m[2].toLowerCase()], 0));
}

export function formatSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

/** Jira's timestamp format: 2026-10-22T10:00:00.000+0000. */
export function jiraTime(ms = Date.now()): string {
  return new Date(ms).toISOString().replace('Z', '+0000');
}
