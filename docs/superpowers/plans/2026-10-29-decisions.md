# Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents of any source ask you decisions as Jira issues of type `Decision`; you settle them (approve, reject, answer) from a Decisions tab of the dashboard; `jira-sim ask` asks and waits in one command.

**Architecture:** A `Decision` issue type with its own flow (`Open` → `Done`, four transitions that each set their resolution) in `types.ts` and `seed.ts`; the server completes the stored workflow metadata with what the seed adds (`withSeedWorkflow`), so old databases get the type without a write and no storage changes. The dashboard (`media/simulator.html`, one self-contained page) gets a Decisions tab over the same `/_sim/api` transitions. `src/ask.ts` is a REST v3 client loaded only by `cli.ts`.

**Tech Stack:** TypeScript (strict, commonjs, ES2022, no runtime dependencies), node ≥ 18 (`fetch`), plain HTML/JS dashboard. No test framework in the repo: verification is `npm run compile` plus node smoke scripts kept under `.simulator/smoke/` (git-ignored, not committed).

**Spec:** `docs/superpowers/specs/2026-10-29-decisions-design.md`.

**Conventions (from `AGENTS.md`):** conventional commits with a scope, lowercase imperative (`feat(server): …`); code comments are short sentences that say why; every module opens with a header comment (role, dependency constraints); new CLI flags go in `README.md` and the `USAGE` string of `cli.ts`; nothing internal (no company names, no sample data) in the repo. Every commit message ends with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf
```

Run every command from the repository root, `/home/snowtea/HDD/git/jira-sim`.

---

## File map

| File | Change |
|------|--------|
| `src/server.ts` | Fix the dashboard page path (Task 1); `context()` completed by `withSeedWorkflow`; Decision rules in `transition()` and `transitionJson()` (Task 2) |
| `src/types.ts` | `DECISION`, `DECISION_FLOW`, `SimTransition.resolution` / `needsComment`, resolution `Answered`, `transitionsOf` (Task 2) |
| `src/seed.ts` | Issue type `Decision`; `withSeedWorkflow` (Task 2) |
| `media/simulator.html` | Decisions tab, Board filter, transition form, Decision flow in settings (Task 3) |
| `src/ask.ts` | New: `jira-sim ask` (Task 4) |
| `src/cli.ts` | `ask` subcommand, `USAGE` (Task 4) |
| `scripts/check-boundaries.js` | Rules for `ask.ts` (Task 4) |
| `README.md`, `AGENTS.md` | Docs (Task 5) |
| `.simulator/smoke/*.mjs` | Smoke scripts, not committed (Tasks 1, 2, 4, 6) |

---

### Task 1: Serve the dashboard page from the package

`server.ts` looks for the page at `path.join(__dirname, '..', '..', 'media', 'simulator.html')`, a leftover of the old `src/simulator` layout: from `out/server.js` that is outside the package. `readFileSync` then throws after `writeHead`, so the catch in `handle()` cannot answer and the request hangs. Every later dashboard step depends on this.

**Files:**
- Modify: `src/server.ts` (method `dashboard`, the `p === '/'` branch)
- Test: `.simulator/smoke/page.mjs`

- [ ] **Step 1: Write the failing check**

Create `.simulator/smoke/page.mjs`:

```js
// The dashboard page is served from the package: GET / answers 200 with the page.
import { createRequire } from 'module';
import assert from 'assert/strict';
const require = createRequire(import.meta.url);
const { JiraSimulator } = require(`${process.cwd()}/out/server.js`);

const sim = new JiraSimulator({ port: 0 });
await sim.start();
try {
  const r = await fetch(`${sim.url}/`, { signal: AbortSignal.timeout(3000) });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>Jira simulator<\/title>/);
} finally {
  await sim.stop();
}
console.log('page smoke: ok');
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run compile && node .simulator/smoke/page.mjs`
Expected: FAIL with `TimeoutError` (the request hangs, then the 3 s abort fires).

- [ ] **Step 3: Fix the path and read before the headers**

In `src/server.ts`, replace:

```ts
    if (p === '/' || p === '/index.html') {
      const file = this.opts.dashboardFile ?? path.join(__dirname, '..', '..', 'media', 'simulator.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }
```

with:

```ts
    if (p === '/' || p === '/index.html') {
      // Read before the headers go out: a missing page is then a 500, not a request left open.
      const page = fs.readFileSync(this.opts.dashboardFile ?? path.join(__dirname, '..', 'media', 'simulator.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
```

- [ ] **Step 4: Run it to see it pass**

Run: `npm run compile && node .simulator/smoke/page.mjs`
Expected: `check-boundaries: ok`, then `page smoke: ok`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "fix(server): serve the dashboard page from the package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf"
```

---

### Task 2: The Decision issue type in the REST API

**Files:**
- Modify: `src/types.ts` (header comment, `SimTransition`, `RESOLUTIONS`, new `DECISION` / `DECISION_FLOW`, `transitionsOf`)
- Modify: `src/seed.ts` (issue types, new `withSeedWorkflow`)
- Modify: `src/server.ts` (imports, new private `context()`, `transition()`, `transitionJson()`)
- Test: `.simulator/smoke/decisions.mjs`

- [ ] **Step 1: Write the failing smoke script**

Create `.simulator/smoke/decisions.mjs`:

```js
// Smoke test of the Decision issue type over the REST API v3.
//   node .simulator/smoke/decisions.mjs          an in-memory simulator, then an old state file
//   node .simulator/smoke/decisions.mjs <url>    a running simulator (MongoDB, PostgreSQL), REST checks only
import { createRequire } from 'module';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
const require = createRequire(import.meta.url);
const { JiraSimulator } = require(`${process.cwd()}/out/server.js`);
const { seedState } = require(`${process.cwd()}/out/seed.js`);

const AUTH = 'Basic ' + Buffer.from('agent:x').toString('base64');
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const client = (url) => async (method, p, body) => {
  const r = await fetch(url + p, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : undefined };
};
const settings = (url, s) => fetch(`${url}/_sim/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) });

async function withSim(opts, fn) {
  const sim = new JiraSimulator({ port: 0, ...opts });
  await sim.start();
  try {
    await settings(sim.url, { latencyMs: 0 });
    await fn(sim.url);
  } finally {
    await sim.stop();
  }
}

async function contract(url) {
  const api = client(url);
  const project = (await (await fetch(`${url}/_sim/ping`)).json()).project;
  const ask = async (summary) => {
    const r = await api('POST', '/rest/api/3/issue', { fields: { project: { key: project }, issuetype: { name: 'Decision' }, summary, labels: ['agent:smoke'], description: adf('context') } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.key;
  };
  const fields = async (key) => (await api('GET', `/rest/api/3/issue/${key}?fields=resolution,comment`)).body.fields;
  const move = (key, id, comment) => api('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id }, ...(comment ? { update: { comment: [{ add: { body: adf(comment) } }] } } : {}) });
  const waiting = async () => (await api('POST', '/rest/api/3/search/jql', { jql: 'issuetype = Decision AND resolution is EMPTY AND labels = "agent:smoke"', fields: ['summary'] })).body.issues.map((i) => i.key);

  const before = await waiting();
  const [a, b, c, d] = [await ask('Approve me?'), await ask('Reject me?'), await ask('Answer me?'), await ask('Withdraw me?')];
  assert.deepEqual((await waiting()).filter((k) => !before.includes(k)).sort(), [a, b, c, d].sort());
  assert.equal((await fields(a)).resolution, null);

  const tr = await api('GET', `/rest/api/3/issue/${a}/transitions?expand=transitions.fields`);
  assert.deepEqual(tr.body.transitions.map((t) => `${t.id} ${t.name}`), ['91 Approve', '92 Reject', '93 Answer', '94 Withdraw']);
  assert.deepEqual(tr.body.transitions[0].fields, {}, 'a Decision transition asks no resolution');

  assert.equal((await move(a, '91')).status, 204);
  assert.equal((await fields(a)).resolution.name, 'Approved');

  assert.equal((await move(b, '92', 'not now')).status, 204);
  const fb = await fields(b);
  assert.equal(fb.resolution.name, 'Rejected');
  assert.equal(fb.comment.comments.at(-1).body.content[0].content[0].text, 'not now');

  const bare = await move(c, '93');
  assert.equal(bare.status, 400);
  assert.equal(bare.body.errors.comment, 'Comment is required.');
  assert.equal((await fields(c)).resolution, null, 'a refused Answer leaves it waiting');
  assert.equal((await move(c, '93', 'use PostgreSQL')).status, 204);
  assert.equal((await fields(c)).resolution.name, 'Answered');

  assert.equal((await move(d, '94')).status, 204);
  assert.equal((await fields(d)).resolution.name, 'Cancelled');
  assert.equal((await move(d, '91')).status, 400, 'a settled decision has no transition left');

  assert.deepEqual(await waiting(), before);

  // The free workflow is for epics and tasks: a Decision keeps its four transitions, a task still gets the free ones.
  await settings(url, { workflow: 'free' });
  try {
    const e = await ask('Still four?');
    assert.deepEqual((await api('GET', `/rest/api/3/issue/${e}/transitions`)).body.transitions.map((t) => t.id), ['91', '92', '93', '94']);
    assert.equal((await move(e, '94')).status, 204);
    const t = await api('POST', '/rest/api/3/issue', { fields: { project: { key: project }, issuetype: { name: 'Task' }, summary: 'A task' } });
    assert.ok((await api('GET', `/rest/api/3/issue/${t.body.key}/transitions`)).body.transitions.length > 4);
  } finally {
    await settings(url, { workflow: 'conventions' });
  }
}

if (process.argv[2]) {
  await settings(process.argv[2], { latencyMs: 0 });
  await contract(process.argv[2]);
} else {
  await withSim({}, contract);

  // A state written before Decisions: the type and the resolution come from the seed on read, the ids stay.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-sim-')), 'old.json');
  const old = seedState('OLD');
  old.issueTypes = old.issueTypes.filter((t) => t.name !== 'Decision');
  old.resolutions = old.resolutions.filter((r) => r !== 'Answered');
  fs.writeFileSync(file, JSON.stringify(old));
  await withSim({ stateFile: file }, async (url) => {
    const api = client(url);
    const r = await api('POST', '/rest/api/3/issue', { fields: { project: { key: 'OLD' }, issuetype: { name: 'Decision' }, summary: 'Old state?' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const done = await api('POST', `/rest/api/3/issue/${r.body.key}/transitions`, { transition: { id: '93' }, update: { comment: [{ add: { body: adf('yes') } }] } });
    assert.equal(done.status, 204, JSON.stringify(done.body));
    const res = (await api('GET', '/rest/api/3/resolution')).body;
    assert.equal(res[0].name, 'Done', 'the stored resolutions keep their ids');
    assert.equal(res.at(-1).name, 'Answered');
  });
}
console.log('decisions smoke: ok');
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run compile && node .simulator/smoke/decisions.mjs`
Expected: FAIL, `AssertionError` on the first create: status `400`, body `{"errorMessages":[],"errors":{"issuetype":"The issue type selected is invalid."}}`.

- [ ] **Step 3: The model in `src/types.ts`**

Replace the header line:

```ts
// State of the Jira simulator: one project, its issues and links, the seeded epic and task workflows, the simulated validators and faults.
```

with:

```ts
// State of the Jira simulator: one project, its issues and links, the seeded epic, task and decision workflows, the simulated validators and faults.
```

Replace:

```ts
export interface SimTransition { id: string; name: string; from: string | '*'; to: string }
```

with:

```ts
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
```

After `TASK_FLOW` (before `export const RESOLUTIONS`), add:

```ts
/** The issue type agents ask you a decision with. */
export const DECISION = 'Decision';

/** A Decision goes from Open to Done once: the transition taken is the outcome, and its resolution is what agents read. */
export const DECISION_FLOW: SimTransition[] = [
  { id: '91', name: 'Approve', from: 'Open', to: 'Done', resolution: 'Approved' },
  { id: '92', name: 'Reject', from: 'Open', to: 'Done', resolution: 'Rejected' },
  { id: '93', name: 'Answer', from: 'Open', to: 'Done', resolution: 'Answered', needsComment: true },
  { id: '94', name: 'Withdraw', from: 'Open', to: 'Done', resolution: 'Cancelled' }
];
```

Replace:

```ts
export const RESOLUTIONS = ['Done', 'Resolved', 'Approved', 'Rejected', "Won't Do", 'Duplicate', 'Invalid', 'Cannot Reproduce', 'Declined', 'Cancelled', 'Abandoned'];
```

with (appended last: a resolution's id is 10000 + its index):

```ts
export const RESOLUTIONS = ['Done', 'Resolved', 'Approved', 'Rejected', "Won't Do", 'Duplicate', 'Invalid', 'Cannot Reproduce', 'Declined', 'Cancelled', 'Abandoned', 'Answered'];
```

Replace:

```ts
export function transitionsOf(state: Pick<SimState, 'statuses' | 'settings'>, issue: Pick<SimIssue, 'type' | 'status'>): SimTransition[] {
  if (state.settings.workflow === 'free') {
```

with:

```ts
export function transitionsOf(state: Pick<SimState, 'statuses' | 'settings'>, issue: Pick<SimIssue, 'type' | 'status'>): SimTransition[] {
  // A Decision keeps its own flow whatever the setting: the free workflow is for epics and tasks.
  if (issue.type === DECISION) { return DECISION_FLOW.filter((t) => t.from === issue.status); }
  if (state.settings.workflow === 'free') {
```

- [ ] **Step 4: The seed in `src/seed.ts`**

Replace:

```ts
      { id: '10004', name: 'Sub-task', hierarchyLevel: -1 }
    ],
```

with:

```ts
      { id: '10004', name: 'Sub-task', hierarchyLevel: -1 },
      { id: '10005', name: 'Decision', hierarchyLevel: 0 }
    ],
```

At the end of the file, add:

```ts

/**
 * The stored workflow metadata with the issue types and resolutions the seed gained since it was written, so a database
 * seeded before Decisions has them on every read, without a write. Appended: the stored resolutions keep their ids.
 */
export function withSeedWorkflow<T extends Pick<SimState, 'issueTypes' | 'resolutions'>>(ctx: T): T {
  const seed = seedState();
  const types = seed.issueTypes.filter((t) => !ctx.issueTypes.some((x) => x.name === t.name));
  const resolutions = seed.resolutions.filter((r) => !ctx.resolutions.includes(r));
  return types.length || resolutions.length ? { ...ctx, issueTypes: [...ctx.issueTypes, ...types], resolutions: [...ctx.resolutions, ...resolutions] } : ctx;
}
```

- [ ] **Step 5: The server reads the completed context**

In `src/server.ts`, replace the imports:

```ts
import { DEFAULT_PROJECT, seedState } from './seed';
import { FileStorage, SimContext, SimStorage } from './storage';
import {
  DEFAULT_SETTINGS, durationSeconds, formatSeconds, IssueCore, jiraTime, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink,
  SimSettings, SimState, SimTransition, SimWorklog, STATUS_CATEGORIES, statusOf, transitionsOf
} from './types';
```

with:

```ts
import { DEFAULT_PROJECT, seedState, withSeedWorkflow } from './seed';
import { FileStorage, SimContext, SimStorage } from './storage';
import {
  DECISION, DEFAULT_SETTINGS, durationSeconds, formatSeconds, IssueCore, jiraTime, LogEntry, SimChange, SimComment, SimFault, SimIssue, SimLink,
  SimSettings, SimState, SimTransition, SimWorklog, STATUS_CATEGORIES, statusOf, transitionsOf
} from './types';
```

Make every read of the context go through one method:

Run: `sed -i 's/this\.storage\.context()/this.context()/g' src/server.ts && grep -c 'this\.context()' src/server.ts`
Expected: `4` (in `summary`, `reset`, `api`, `dashboardApi`).

Then, right after the `summary()` method, add:

```ts
  /** The stored context, completed with what the seed gained since the state was written (the Decision type). */
  private async context(): Promise<SimContext> {
    return withSeedWorkflow(await this.storage.context());
  }
```

- [ ] **Step 6: The Decision rules in `transition()`**

In `src/server.ts`, replace:

```ts
    const resName = fields.resolution?.name ?? (fields.resolution?.id ? ctx.resolutions[Number(fields.resolution.id) - 10000] : undefined);
    if (fields.resolution && toDone && !ctx.resolutions.includes(resName)) { errors.resolution = "Could not find valid 'id' or 'name' in resolution object."; }
    if (toDone && !fields.resolution && ctx.settings.resolutionRequired) { errors.resolution = 'Resolution is required.'; }
    if (Object.keys(errors).length) { throw fieldErrors(errors); }
    const addWorklog = update.worklog?.find((w) => w.add)?.add;
    if (toDone && issue.type !== 'Epic' && ctx.settings.worklogRequired && !issue.worklogs.length && !addWorklog) {
```

with:

```ts
    // A transition that sets its own resolution (a Decision's) ignores the one asked, as a post-function would.
    const resName = t.resolution ?? fields.resolution?.name ?? (fields.resolution?.id ? ctx.resolutions[Number(fields.resolution.id) - 10000] : undefined);
    if (fields.resolution && toDone && !t.resolution && !ctx.resolutions.includes(resName)) { errors.resolution = "Could not find valid 'id' or 'name' in resolution object."; }
    if (toDone && !fields.resolution && !t.resolution && ctx.settings.resolutionRequired) { errors.resolution = 'Resolution is required.'; }
    const comments = (update.comment ?? []).filter((c) => c.add);
    if (t.needsComment && !comments.length) { errors.comment = 'Comment is required.'; }
    if (Object.keys(errors).length) { throw fieldErrors(errors); }
    const addWorklog = update.worklog?.find((w) => w.add)?.add;
    if (toDone && issue.type !== 'Epic' && issue.type !== DECISION && ctx.settings.worklogRequired && !issue.worklogs.length && !addWorklog) {
```

Replace:

```ts
    for (const c of update.comment ?? []) { if (c.add) { await this.comment(issue, c.add.body, actor); } }
```

with:

```ts
    for (const c of comments) { await this.comment(issue, c.add.body, actor); }
```

(`patch.resolution = resName ?? 'Done';` further down stays as it is: `resName` now carries the Decision's resolution.)

- [ ] **Step 7: A Decision transition asks no resolution**

In `transitionJson`, replace:

```ts
      ...(withFields ? { fields: toDone ? { resolution: {
```

with:

```ts
      ...(withFields ? { fields: toDone && !t.resolution ? { resolution: {
```

- [ ] **Step 8: Run the smoke script to see it pass**

Run: `npm run compile && node .simulator/smoke/decisions.mjs && node .simulator/smoke/page.mjs`
Expected: `check-boundaries: ok`, `decisions smoke: ok`, `page smoke: ok`.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/seed.ts src/server.ts
git commit -m "feat(server): the decision issue type agents ask with

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf"
```

---

### Task 3: The Decisions tab of the dashboard

All in `media/simulator.html`. The page has no build: check its script with `node --check` and the result in a browser.

**Files:**
- Modify: `media/simulator.html`
- Check: `.simulator/smoke/dash.js` (extracted script), a browser

- [ ] **Step 1: Styles**

Replace:

```css
.type.Epic { background: var(--epic); } .type.Task { background: var(--task); } .type.Bug { background: var(--bug); } .type.Story { background: var(--story); } .type.Sub-task { background: var(--task); }
```

with:

```css
.type.Epic { background: var(--epic); } .type.Task { background: var(--task); } .type.Bug { background: var(--bug); } .type.Story { background: var(--story); } .type.Sub-task { background: var(--task); } .type.Decision { background: var(--st-hold); }
```

Replace:

```css
.count.err { background: var(--err-bg); color: var(--err); }
```

with:

```css
.count.err { background: var(--err-bg); color: var(--err); }
.count.hot { background: var(--accent); color: var(--accent-fg); font-weight: 700; }
```

Replace:

```css
.history { font-size: 12.5px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
```

with:

```css
.history { font-size: 12.5px; color: var(--muted); display: flex; flex-direction: column; gap: 3px; }
.decision { border-left: 3px solid var(--st-hold); }
.decision.settled { border-left-color: var(--line-strong); }
.decision .q { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.decision .desc { max-height: 280px; overflow: auto; overflow-wrap: anywhere; }
```

- [ ] **Step 2: State**

Replace:

```js
  data: null, live: false, tab: store.get('tab') || 'board', open: null, as: store.get('as') || 'sim-sam',
  board: { type: 'all', epic: '', q: '', done: true },
```

with:

```js
  data: null, live: false, tab: store.get('tab') || 'decisions', open: null, as: store.get('as') || 'sim-sam',
  board: { type: 'all', epic: '', q: '', done: true, decisions: false },
  dec: { source: '' },
```

- [ ] **Step 3: Helpers**

After the line `const typeIcon = (t) => …;`, add:

```js
const isDecision = (i) => i.type === 'Decision';
const sourceOf = (i) => (i.labels.find((l) => l.startsWith('agent:')) || 'agent:unknown').slice('agent:'.length);
const OUTCOME = { Approved: 'Approved', Rejected: 'Rejected', Answered: 'Answered', Cancelled: 'Withdrawn' };
const waitingDecisions = () => S.data.issues.filter((i) => isDecision(i) && !i.resolution);
```

- [ ] **Step 4: Render the tab, and the count in the title**

In `render()`, replace:

```js
  $('#app').innerHTML = header() + tabs() + `<main>${S.tab === 'requests' ? requests() : S.tab === 'faults' ? faults() : S.tab === 'settings' ? settings() : board()}</main>` + drawer() + modal();
```

with:

```js
  const waiting = waitingDecisions().length;
  document.title = (waiting ? `(${waiting}) ` : '') + 'Jira simulator';
  $('#app').innerHTML = header() + tabs() + `<main>${S.tab === 'decisions' ? decisions() : S.tab === 'requests' ? requests() : S.tab === 'faults' ? faults() : S.tab === 'settings' ? settings() : board()}</main>` + drawer() + modal();
```

In `tabs()`, replace:

```js
  return `<nav class="tabs" aria-label="Sections">
    ${t('board', 'Board', `<span class="count">${S.data.issues.length}</span>`)}
```

with:

```js
  const waiting = waitingDecisions().length;
  return `<nav class="tabs" aria-label="Sections">
    ${t('decisions', 'Decisions', `<span class="count ${waiting ? 'hot' : ''}">${waiting}</span>`)}
    ${t('board', 'Board', `<span class="count">${S.data.issues.filter((i) => !isDecision(i)).length}</span>`)}
```

- [ ] **Step 5: The Decisions view**

Before `function requests() {`, add:

```js
function decisions() {
  const all = S.data.issues.filter(isDecision);
  const sources = [...new Set(all.map(sourceOf))].sort();
  const src = sources.includes(S.dec.source) ? S.dec.source : '';
  const shown = all.filter((i) => !src || sourceOf(i) === src);
  const waiting = shown.filter((i) => !i.resolution).sort((x, y) => Date.parse(x.created) - Date.parse(y.created));
  const settled = shown.filter((i) => i.resolution).sort((x, y) => Date.parse(y.resolutionDate || y.updated) - Date.parse(x.resolutionDate || x.updated)).slice(0, 30);
  const count = (s) => all.filter((i) => !i.resolution && (!s || sourceOf(i) === s)).length;
  return `<div class="toolbar">
      <select id="decSource" data-change="decSource" aria-label="Source"><option value="">All sources · ${count('')} waiting</option>${sources.map((s) => `<option value="${esc(s)}" ${s === src ? 'selected' : ''}>${esc(s)} · ${count(s)} waiting</option>`).join('')}</select>
      <span class="grow"></span>
      <span class="muted small">Agents ask with an issue of type Decision and a label agent:&lt;source&gt;; you answer as ${esc(userName(S.data.me))}.</span>
    </div>
    <section class="block"><h2>Waiting · ${waiting.length}</h2><div class="list">${waiting.map(decisionCard).join('') || '<div class="box"><span class="muted">Nothing waits for you.</span></div>'}</div></section>
    <section class="block"><h2>Settled</h2><div class="list">${settled.map(settledCard).join('') || '<div class="box"><span class="muted">None yet.</span></div>'}</div></section>`;
}
function aboutOf(i) {
  const rel = S.data.links.filter((l) => l.inward === i.key || l.outward === i.key).map((l) => issue(l.inward === i.key ? l.outward : l.inward)).filter(Boolean);
  return rel.length ? `<div class="small">About ${rel.map((r) => `<a class="mono" data-do="openOnBoard" data-key="${esc(r.key)}">${esc(r.key)}</a> <span class="muted">${esc(r.summary)}</span>`).join(', ')}</div>` : '';
}
function decisionCard(i) {
  const id = 'dec-' + i.key;
  const text = dirty.get(id) ?? '';
  // Withdraw is the agent's: you approve, reject or answer.
  const buttons = i.transitions.filter((t) => t.resolution && t.resolution !== 'Cancelled').map((t) => `<button ${t.needsComment ? `id="need-${esc(i.key)}"` : ''} class="btn sm ${t.resolution === 'Approved' ? 'primary' : t.resolution === 'Rejected' ? 'danger' : ''}" data-do="decide" data-key="${esc(i.key)}" data-id="${esc(t.id)}" ${t.needsComment && !text.trim() ? 'disabled' : ''}>${esc(t.name)}</button>`).join('');
  return `<div class="box decision" aria-label="Decision ${esc(i.key)}">
    <div class="row small"><a class="mono" data-do="openOnBoard" data-key="${esc(i.key)}">${esc(i.key)}</a><span class="chip">${esc(sourceOf(i))}</span><span class="muted">asked ${ago(i.created)}</span></div>
    <div class="q">${esc(i.summary)}</div>
    ${i.descriptionText ? `<div class="desc">${descHtml(i.descriptionText)}</div>` : ''}
    ${aboutOf(i)}
    <textarea id="${esc(id)}" rows="2" data-input="decText" data-key="${esc(i.key)}" placeholder="Comment, reason or answer (Answer needs one)" aria-label="Comment, reason or answer"></textarea>
    <div class="row">${buttons}</div>
  </div>`;
}
function settledCard(i) {
  const reply = i.comments[i.comments.length - 1];
  const tone = i.resolution === 'Approved' ? 'done' : i.resolution === 'Rejected' ? 'hold' : i.resolution === 'Answered' ? 'indeterminate' : 'new';
  return `<div class="box decision settled">
    <div class="row small"><a class="mono" data-do="openOnBoard" data-key="${esc(i.key)}">${esc(i.key)}</a><span class="chip">${esc(sourceOf(i))}</span><span class="pill ${tone}">${esc(OUTCOME[i.resolution] || i.resolution)}</span><span class="muted">${ago(i.resolutionDate || i.updated)}</span></div>
    <div class="q" style="font-size:13.5px;font-weight:400">${esc(i.summary)}</div>
    ${aboutOf(i)}
    ${reply ? `<div class="item"><div class="by"><strong>${esc(userName(reply.author))}</strong> · ${ago(reply.created)}</div><div class="desc">${descHtml(reply.text)}</div></div>` : ''}
  </div>`;
}
```

- [ ] **Step 6: Leave Decisions out of the Board by default**

In `board()`, replace:

```js
    (b.type === 'all' || (b.type === 'epics' ? i.type === 'Epic' : i.type !== 'Epic')) &&
```

with:

```js
    (b.decisions || !isDecision(i)) &&
    (b.type === 'all' || (b.type === 'epics' ? i.type === 'Epic' : i.type !== 'Epic')) &&
```

Replace:

```js
      <label class="check"><input type="checkbox" data-change="boardDone" ${b.done ? 'checked' : ''}> Show Done</label>
```

with:

```js
      <label class="check"><input type="checkbox" data-change="boardDone" ${b.done ? 'checked' : ''}> Show Done</label>
      <label class="check"><input type="checkbox" data-change="boardDecisions" ${b.decisions ? 'checked' : ''}> Show decisions</label>
```

- [ ] **Step 7: The issue panel's transition form**

In `drawer()`, replace:

```js
      ${p ? `<div class="tr-form"><strong>${esc(p.name)} → ${esc(p.to)}</strong>
        <div class="row"><label class="field" style="flex:1 1 160px"><span>Resolution</span><select id="tr-res"><option value="">(none)</option>${S.data.resolutions.map((r) => `<option ${r === 'Done' ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          ${i.type !== 'Epic' ? '<label class="field" style="flex:1 1 120px"><span>Time spent</span><input id="tr-time" type="text" placeholder="1h 30m"></label>' : ''}</div>
        <label class="field"><span>Comment</span><textarea id="tr-comment" rows="2"></textarea></label>
```

with:

```js
      ${p ? `<div class="tr-form"><strong>${esc(p.name)} → ${esc(p.to)}${p.resolution ? ` · ${esc(p.resolution)}` : ''}</strong>
        ${p.resolution ? '' : `<div class="row"><label class="field" style="flex:1 1 160px"><span>Resolution</span><select id="tr-res"><option value="">(none)</option>${S.data.resolutions.map((r) => `<option ${r === 'Done' ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          ${i.type !== 'Epic' ? '<label class="field" style="flex:1 1 120px"><span>Time spent</span><input id="tr-time" type="text" placeholder="1h 30m"></label>' : ''}</div>`}
        <label class="field"><span>Comment${p.needsComment ? ' (required)' : ''}</span><textarea id="tr-comment" rows="2"></textarea></label>
```

(`confirmTransition` needs no change: `val('tr-res')` is `''` when the select is absent, so no resolution is sent.)

- [ ] **Step 8: The Decision flow in Workflow & settings**

In `settings()`, replace:

```js
    ${st.workflow === 'free' ? '<div class="box"><span class="muted">Free workflow: every status has a transition to every other status, named after it.</span></div>' : flow('Epic',
```

with:

```js
    ${flow('Decision · in either workflow', [['Open', 'Approve', 'Done · Approved'], ['Open', 'Reject', 'Done · Rejected'], ['Open', 'Answer (comment required)', 'Done · Answered'], ['Open', 'Withdraw', 'Done · Cancelled']])}
    ${st.workflow === 'free' ? '<div class="box"><span class="muted">Free workflow: every status has a transition to every other status, named after it.</span></div>' : flow('Epic',
```

- [ ] **Step 9: Actions, changes, input, hash**

In `const A = {`, after the line `boardType: (el) => { … },`, add:

```js
  decide: (el) => run(async () => {
    const key = el.dataset.key;
    const t = issue(key)?.transitions.find((x) => x.id === el.dataset.id);
    if (!t) { toast(`${key} is already settled`, true); return; }
    const comment = val('dec-' + key).trim();
    // You settle it, whoever the dashboard acts as elsewhere.
    await api('POST', `/issue/${key}/transition`, { id: t.id, comment: comment || undefined, as: S.data.me });
    consume('dec-' + key);
    toast(`${key}: ${OUTCOME[t.resolution] || t.name}`);
  }),
  openOnBoard: (el) => { S.tab = 'board'; store.set('tab', 'board'); A.open(el); },
```

In `const CHANGE = {`, after `boardDone: …,`, add:

```js
  boardDecisions: (el) => { S.board.decisions = el.checked; render(); },
  decSource: (el) => { S.dec.source = el.value; render(); },
```

In the `input` listener, replace:

```js
  if (k === 'logQ') { S.log.q = e.target.value; render(); }
```

with:

```js
  if (k === 'logQ') { S.log.q = e.target.value; render(); }
  // Without a re-render: Answer is enabled as soon as there is text.
  if (k === 'decText') { const b = document.getElementById('need-' + e.target.dataset.key); if (b) { b.disabled = !e.target.value.trim(); } }
```

In `fromHash`, replace:

```js
  const t = /tab=(board|requests|faults|settings)/.exec(location.hash);
```

with:

```js
  const t = /tab=(decisions|board|requests|faults|settings)/.exec(location.hash);
```

- [ ] **Step 10: Check the script parses**

Run: `node -e "const h=require('fs').readFileSync('media/simulator.html','utf8');require('fs').writeFileSync('.simulator/smoke/dash.js',h.split('<script>')[1].split('</script>')[0])" && node --check .simulator/smoke/dash.js && echo parse-ok`
Expected: `parse-ok`.

- [ ] **Step 11: Check it in a browser**

Start a simulator in the background (Bash `run_in_background`): `npm run compile && node out/cli.js --port 4866`.

Create three decisions, one about a task:

```bash
A='Authorization: Basic YWdlbnQ6eA=='; J='Content-Type: application/json'; U=http://127.0.0.1:4866/rest/api/3
curl -s -H "$A" -H "$J" $U/issue -d '{"fields":{"project":{"key":"SIM"},"issuetype":{"name":"Task"},"summary":"Upgrade the gateway"}}'
curl -s -H "$A" -H "$J" $U/issue -d '{"fields":{"project":{"key":"SIM"},"issuetype":{"name":"Decision"},"summary":"Push feature/x to origin?","labels":["agent:claude-code"],"description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"3 commits, tests pass."}]}]}}}'
curl -s -H "$A" -H "$J" $U/issue -d '{"fields":{"project":{"key":"SIM"},"issuetype":{"name":"Decision"},"summary":"Which database for the cache?","labels":["agent:devfactory"]}}'
curl -s -H "$A" -H "$J" $U/issueLink -d '{"type":{"name":"Relates"},"inwardIssue":{"key":"SIM-3"},"outwardIssue":{"key":"SIM-1"}}'
```

Open `http://127.0.0.1:4866/#tab=decisions` (chrome-devtools `new_page`) and check, with a snapshot or screenshot each:
- The tab bar starts with `Decisions 2` (accent count); the title is `(2) Jira simulator`; Board counts 1 issue.
- Two cards, oldest first; SIM-3 shows "About SIM-1 Upgrade the gateway"; SIM-2 shows its description.
- The source filter lists `claude-code · 1 waiting` and `devfactory · 1 waiting`; picking one shows only its card.
- On SIM-3, **Answer** is disabled; typing `Redis` enables it; clicking it moves SIM-3 to Settled as `Answered` with the reply `Redis` by "You". The count drops to 1 live.
- **Reject** on SIM-2 with no text: Settled shows `Rejected`, no reply.
- `curl -s -H "$A" -H "$J" $U/issue -d '{"fields":{"project":{"key":"SIM"},"issuetype":{"name":"Decision"},"summary":"Withdraw me?","labels":["agent:smoke"]}}'` then `curl -s -H "$A" -H "$J" $U/issue/SIM-4/transitions -d '{"transition":{"id":"94"}}'`: the card appears, then moves to Settled as `Withdrawn`, without a reload.
- Board: no Decision cards until **Show decisions** is ticked. Opening SIM-4 from Settled opens its panel on the Board.
- On the Board, a new Decision's panel: clicking **Answer** shows the form without Resolution and Time spent, with "Comment (required)".
- Workflow & settings shows the Decision flow, in Conventions and in Free.
- `emulate` with `colorScheme: dark`: readable. `resize_page` to 390×800: no horizontal page scroll, cards wrap.

Stop the background simulator.

- [ ] **Step 12: Commit**

```bash
git add media/simulator.html
git commit -m "feat(dashboard): the decisions tab to settle what agents ask

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf"
```

---

### Task 4: `jira-sim ask`

**Files:**
- Create: `src/ask.ts`
- Modify: `src/cli.ts` (header, `USAGE`, `main`)
- Modify: `scripts/check-boundaries.js` (rules for `ask.ts`)
- Test: `.simulator/smoke/ask.mjs`

- [ ] **Step 1: Write the failing smoke script**

Create `.simulator/smoke/ask.mjs`:

```js
// Smoke test of jira-sim ask against an in-memory simulator: each exit code, --json, --about, the timeout that withdraws.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import assert from 'assert/strict';
const require = createRequire(import.meta.url);
const { JiraSimulator } = require(`${process.cwd()}/out/server.js`);

const sim = new JiraSimulator({ port: 0 });
await sim.start();
const AUTH = 'Basic ' + Buffer.from('you@example.test:x').toString('base64');
const rest = async (method, p, body) => {
  const r = await fetch(sim.url + p, { method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const t = await r.text();
  return t ? JSON.parse(t) : undefined;
};
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
await fetch(`${sim.url}/_sim/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ latencyMs: 0 }) });
const task = (await rest('POST', '/rest/api/3/issue', { fields: { project: { key: 'SIM' }, issuetype: { name: 'Task' }, summary: 'A task' } })).key;

/** Runs jira-sim ask; `settle` acts on the decision once it says it waits. */
function ask(args, settle) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['out/cli.js', 'ask', ...args, '--url', sim.url], { env: { ...process.env, JIRA_EMAIL: '', JIRA_TOKEN: '', JIRA_URL: '' } });
    let out = '';
    let err = '';
    let settled = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      err += d;
      const m = /(SIM-\d+) waits for your decision/.exec(err);
      if (m && settle && !settled) { settled = true; void settle(m[1]); }
    });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const move = (id, comment) => (key) => rest('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id }, ...(comment ? { update: { comment: [{ add: { body: adf(comment) } }] } } : {}) });

try {
  let r = await ask(['Push feature/x?', '--agent', 'smoke'], move('91'));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^approved SIM-\d+\n$/);

  r = await ask(['Delete the branch?', '--agent', 'smoke'], move('92', 'keep it'));
  assert.equal(r.code, 1, r.err);
  assert.match(r.out, /^rejected SIM-\d+\nkeep it\n$/);

  r = await ask(['Which database?', '--agent', 'smoke', '--about', task, '--json'], move('93', 'PostgreSQL'));
  assert.equal(r.code, 2, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual([j.outcome, j.reply], ['answered', 'PostgreSQL']);
  const issue = await rest('GET', `/rest/api/3/issue/${j.key}?fields=issuelinks,labels`);
  assert.equal(issue.fields.issuelinks[0].type.name, 'Relates');
  assert.deepEqual(issue.fields.labels, ['agent:smoke']);

  r = await ask(['Nobody answers?', '--agent', 'smoke', '--wait', '1s']);
  assert.equal(r.code, 3, r.err);
  assert.match(r.out, /^timeout SIM-\d+\n$/);
  const key = /SIM-\d+/.exec(r.out)[0];
  assert.equal((await rest('GET', `/rest/api/3/issue/${key}?fields=resolution`)).fields.resolution.name, 'Cancelled');

  r = await ask(['No agent']);
  assert.equal(r.code, 4);
  assert.match(r.err, /--agent/);

  r = await ask(['About nothing?', '--agent', 'smoke', '--about', 'SIM-999']);
  assert.equal(r.code, 4);
  assert.match(r.err, /404/);

  const waiting = await rest('POST', '/rest/api/3/search/jql', { jql: 'issuetype = Decision AND resolution is EMPTY' });
  assert.equal(waiting.issues.length, 0, 'nothing stays waiting');
} finally {
  await sim.stop();
}
console.log('ask smoke: ok');
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run compile && node .simulator/smoke/ask.mjs`
Expected: FAIL, `AssertionError` on the first case: the code is not 0 (the CLI starts a simulator, `ask` is not a subcommand yet). If it hangs, the CLI is listening: stop it with Ctrl-C, the failure is the same.

- [ ] **Step 3: Write `src/ask.ts`**

```ts
// `jira-sim ask`: an agent asks you a decision and waits until you settle it, through the Jira REST API v3 only, so it
// works against the simulator or a real Jira with a Decision issue type. Only cli.ts loads it; it imports jiraFormat
// and types, never the server or the storages (scripts/check-boundaries.js).
import * as fs from 'fs';
import { adfToText, textToAdf } from './jiraFormat';
import { DECISION } from './types';

export const ASK_USAGE = `Usage: jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->]
                    [--url <url>] [--project <key>] [--wait <duration>] [--json]

  Creates a Decision issue labelled agent:<source>, waits until you settle it, and prints the outcome and your reply.

  --agent <source>   who asks; becomes the label agent:<source> (letters, digits, . _ -).
  --about <KEY>      the issue it is about, linked to it with "relates to".
  --context <file>   its description, from a file, or - for stdin.
  --url <url>        the simulator or Jira (default: $JIRA_URL or http://127.0.0.1:4865).
  --project <key>    the project (default: the simulator's, from /_sim/ping).
  --wait <duration>  how long to wait: 45s, 30m, 2h, or 0 for no limit (default: 30m). On timeout it withdraws.
  --json             print { key, outcome, reply } instead of text.

  Credentials: $JIRA_EMAIL and $JIRA_TOKEN; without them, the simulator's user jira-sim-ask.
  Exit codes: 0 approved, 1 rejected, 2 answered, 3 withdrawn or timed out, 4 failed.`;

type Outcome = 'approved' | 'rejected' | 'answered' | 'withdrawn' | 'timeout';

export const EXIT: Record<Outcome | 'failed', number> = { approved: 0, rejected: 1, answered: 2, withdrawn: 3, timeout: 3, failed: 4 };

/** A Decision's resolution is its outcome. */
const OUTCOMES: Record<string, Outcome> = { Approved: 'approved', Rejected: 'rejected', Answered: 'answered', Cancelled: 'withdrawn' };

const POLL_MS = 3000;

/** The id /_sim/ping answers with (SIM_ID in server.ts, which this module may not import). */
const SIM_ID = 'devfactory-simulator';

interface AskOptions { question: string; agent: string; about?: string; context?: string; url: string; project?: string; waitMs: number; json: boolean }

interface Answer { key: string; outcome: Outcome; reply: string | null }

/** `transient`: worth trying again while waiting (Jira unreachable, 5xx, 429). */
class AskError extends Error {
  constructor(message: string, readonly transient = false) { super(message); }
}

/** "45s", "30m" or "2h" in milliseconds, "0" for no limit; undefined when invalid. */
export function waitMs(text: string): number | undefined {
  if (text.trim() === '0') { return 0; }
  const m = /^(\d+)(s|m|h)$/.exec(text.trim());
  return m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'] : undefined;
}

function parse(argv: string[]): AskOptions {
  const words: string[] = [];
  const o: { agent?: string; about?: string; context?: string; url?: string; project?: string; wait: string; json: boolean } = { wait: '30m', json: false };
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    const value = () => {
      const v = argv[++n];
      if (v === undefined) { throw new AskError(`${a} needs a value.`); }
      return v;
    };
    if (a === '--agent') { o.agent = value(); } else if (a === '--about') { o.about = value().toUpperCase(); } else if (a === '--context') { o.context = value(); } else if (a === '--url') { o.url = value(); } else if (a === '--project') { o.project = value(); } else if (a === '--wait') { o.wait = value(); } else if (a === '--json') { o.json = true; } else if (a.startsWith('--')) { throw new AskError(`Unknown option ${a}.`); } else { words.push(a); }
  }
  const question = words.join(' ').trim();
  if (!question) { throw new AskError('Say what to decide: jira-sim ask "<question>" --agent <source>.'); }
  if (!o.agent || !/^[\w.-]+$/.test(o.agent)) { throw new AskError('--agent <source> is required: letters, digits, . _ - (it becomes the label agent:<source>).'); }
  const ms = waitMs(o.wait);
  if (ms === undefined) { throw new AskError(`--wait ${o.wait}: give 45s, 30m, 2h or 0.`); }
  const url = (o.url || process.env.JIRA_URL || 'http://127.0.0.1:4865').replace(/\/+$/, '');
  return { question, agent: o.agent, about: o.about, context: o.context, url, project: o.project, waitMs: ms, json: o.json };
}

/** A REST call to the simulator or Jira, with Basic credentials; Jira's error messages in the AskError. */
function client(url: string) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_TOKEN;
  // A user without an @: the simulator renames "you" only after a client's email.
  const auth = 'Basic ' + Buffer.from(email && token ? `${email}:${token}` : 'jira-sim-ask:none').toString('base64');
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    let r: Response;
    try {
      r = await fetch(url + path, {
        method,
        headers: { Authorization: auth, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new AskError(`${url} does not answer: ${e instanceof Error ? e.message : e}`, true);
    }
    const text = await r.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (!r.ok) {
      const why = [...(json?.errorMessages ?? []), ...Object.entries(json?.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join('; ') || text.slice(0, 200) || r.statusText;
      throw new AskError(`${method} ${path}: ${r.status} ${why}`, r.status >= 500 || r.status === 429);
    }
    return json;
  };
}

type Call = ReturnType<typeof client>;

/** The project named, else the simulator's; a real Jira has no ping, so it needs --project. */
async function projectOf(o: AskOptions): Promise<string> {
  if (o.project) { return o.project; }
  try {
    const j = await (await fetch(`${o.url}/_sim/ping`)).json() as { id?: string; project?: string };
    if (j.id === SIM_ID && j.project) { return j.project; }
  } catch { /* not a simulator */ }
  throw new AskError(`No simulator answers at ${o.url}: name the project with --project.`);
}

/** The outcome and your reply (the last comment), or undefined while it waits. */
async function settled(call: Call, key: string): Promise<Answer | undefined> {
  const { fields } = await call('GET', `/rest/api/3/issue/${key}?fields=resolution,comment`);
  const resolution = fields?.resolution?.name as string | undefined;
  if (!resolution) { return undefined; }
  const outcome = OUTCOMES[resolution];
  if (!outcome) { throw new AskError(`${key} was closed as ${resolution}, which is not a decision's outcome.`); }
  const comments = fields.comment?.comments ?? [];
  const last = comments[comments.length - 1];
  return { key, outcome, reply: last ? adfToText(last.body) : null };
}

/** Takes the Withdraw transition, found by name: its id differs in a real Jira. */
async function withdraw(call: Call, key: string) {
  const { transitions } = await call('GET', `/rest/api/3/issue/${key}/transitions`);
  const t = (transitions as { id: string; name: string }[]).find((x) => x.name.toLowerCase() === 'withdraw');
  if (t) { await call('POST', `/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } }); }
}

/** Polls until the decision is settled; at the limit it withdraws it, unless you settled it meanwhile. */
async function wait(call: Call, key: string, limitMs: number): Promise<Answer> {
  const end = limitMs ? Date.now() + limitMs : Infinity;
  for (;;) {
    try {
      const a = await settled(call, key);
      if (a) { return a; }
    } catch (e) {
      // A restart or an injected fault is waited out; a deleted decision is not.
      if (!(e instanceof AskError) || !e.transient) { throw e; }
    }
    if (Date.now() >= end) {
      await withdraw(call, key).catch(() => undefined);
      const a = await settled(call, key).catch(() => undefined);
      return a && a.outcome !== 'withdrawn' ? a : { key, outcome: 'timeout', reply: null };
    }
    await new Promise((r) => setTimeout(r, Math.min(POLL_MS, end - Date.now())));
  }
}

function print(o: AskOptions, a: Answer) {
  if (o.json) { console.log(JSON.stringify(a)); return; }
  console.log(`${a.outcome} ${a.key}`);
  if (a.reply) { console.log(a.reply); }
}

/** Runs `jira-sim ask` with the arguments after "ask"; resolves to its exit code. */
export async function ask(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(ASK_USAGE); return 0; }
  let o: AskOptions;
  try {
    o = parse(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${ASK_USAGE}`);
    return EXIT.failed;
  }
  const call = client(o.url);
  let key: string | undefined;
  try {
    const project = await projectOf(o);
    const description = o.context === undefined ? undefined : textToAdf(fs.readFileSync(o.context === '-' ? 0 : o.context, 'utf8'));
    if (o.about) { await call('GET', `/rest/api/3/issue/${o.about}?fields=summary`); }
    const fields = { project: { key: project }, issuetype: { name: DECISION }, summary: o.question, labels: [`agent:${o.agent}`], ...(description ? { description } : {}) };
    key = (await call('POST', '/rest/api/3/issue', { fields })).key as string;
    // Once it exists, nothing may leave it waiting: Ctrl-C or a kill withdraws it.
    const stop = () => void withdraw(call, key!).catch(() => undefined).then(() => process.exit(EXIT.withdrawn));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (o.about) { await call('POST', '/rest/api/3/issueLink', { type: { name: 'Relates' }, inwardIssue: { key }, outwardIssue: { key: o.about } }); }
    console.error(`${key} waits for your decision: ${o.url}/browse/${key}`);
    const answer = await wait(call, key, o.waitMs);
    print(o, answer);
    return EXIT[answer.outcome];
  } catch (e) {
    if (key) { await withdraw(call, key).catch(() => undefined); }
    console.error(e instanceof AskError ? e.message : e instanceof Error ? e.stack ?? e.message : String(e));
    return EXIT.failed;
  }
}
```

- [ ] **Step 4: The subcommand in `src/cli.ts`**

Replace the header:

```ts
// The Jira simulator as its own process:
//   jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
```

with:

```ts
// The Jira simulator as its own process:
//   jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
//   jira-sim ask <question> --agent <source> [...]   an agent's decision, through the REST API only (ask.ts)
```

Replace:

```ts
const USAGE = `Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
```

with:

```ts
const USAGE = `Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
       jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->] [--url <url>] [--wait 30m] [--json]
                                    ask you a decision and wait for it (jira-sim ask --help)
```

Replace:

```ts
async function main() {
  if (args.includes('--help') || args.includes('-h')) {
```

with:

```ts
async function main() {
  // Loaded only for the subcommand: the simulator itself never needs the client.
  if (args[0] === 'ask') {
    const { ask } = await import('./ask');
    process.exit(await ask(args.slice(1)));
  }
  if (args.includes('--help') || args.includes('-h')) {
```

- [ ] **Step 5: The boundary rules**

In `scripts/check-boundaries.js`, replace the header line:

```js
// Direct imports only: with these rules the server's closure cannot reach the CLI, the mongodb driver or the pg driver.
```

with:

```js
// Direct imports only: with these rules the server's closure cannot reach the CLI, the mongodb driver or the pg driver,
// and `jira-sim ask` (ask.ts) stays a REST client: it never loads the server or a storage.
```

Replace:

```js
  if (target === 'cli') return 'nothing may import the CLI';
```

with:

```js
  if (target === 'cli') return 'nothing may import the CLI';
  if (target === 'ask' && from !== 'cli.ts') return 'only cli.ts may load ask.ts';
  if (from === 'ask.ts' && !['jiraFormat', 'types'].includes(target)) return 'ask.ts imports jiraFormat and types only: it is a REST client';
```

- [ ] **Step 6: Run the smoke scripts to see them pass**

Run: `npm run compile && node .simulator/smoke/ask.mjs && node .simulator/smoke/decisions.mjs`
Expected: `check-boundaries: ok`, `ask smoke: ok` (about 15 s: each case polls every 3 s), `decisions smoke: ok`.

Check the boundary rule bites: `cp src/ask.ts .simulator/smoke/ask.ts.bak && echo "import './server';" >> src/ask.ts; node scripts/check-boundaries.js; cp .simulator/smoke/ask.ts.bak src/ask.ts && node scripts/check-boundaries.js`
Expected: first `src/ask.ts:<n>: './server': ask.ts imports jiraFormat and types only: it is a REST client` and `check-boundaries: 1 violation(s)`, then `check-boundaries: ok`.

Check the help: `node out/cli.js ask --help | head -3 && node out/cli.js --help | head -3`
Expected: the `ask` usage, then the main usage with its `jira-sim ask` line.

- [ ] **Step 7: Commit**

```bash
git add src/ask.ts src/cli.ts scripts/check-boundaries.js
git commit -m "feat(cli): jira-sim ask, a decision asked and waited for in one command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf"
```

---

### Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: README, the usage block**

In `README.md`, inside the usage code block, replace:

```
Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
```

with:

```
Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
       jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->] [--url <url>] [--wait 30m] [--json]
                                    ask you a decision and wait for it (jira-sim ask --help)
```

- [ ] **Step 2: README, the dashboard**

Replace:

```
`http://127.0.0.1:<port>/` — four tabs:

- **Board**: the issues by status,
```

with:

```
`http://127.0.0.1:<port>/` — five tabs:

- **Decisions**: what agents ask you, oldest first, by source, with Approve, Reject and Answer (one text box for a comment, a reason or the answer); then the settled ones with their outcome and your reply. The tab and the page title count what waits. You answer as the simulated you. See [Decisions](#decisions).
- **Board**: the issues by status (decisions left out unless **Show decisions** is ticked),
```

- [ ] **Step 3: README, a Decisions section**

Before `## State: a file, MongoDB or PostgreSQL`, add:

````markdown
## Decisions

Agents of any source (the extension, Claude Code, a script, CI) can put a question to you as an issue of type **Decision**, and wait for your answer in the **Decisions** tab. It is plain Jira: a real Jira with a Decision type and the same transitions works the same way.

| Transition | id | From → to | Resolution | |
|------------|----|-----------|------------|-|
| Approve | 91 | Open → Done | Approved | comment optional |
| Reject | 92 | Open → Done | Rejected | comment optional: the reason |
| Answer | 93 | Open → Done | Answered | a comment is required (`update.comment`) |
| Withdraw | 94 | Open → Done | Cancelled | the agent gives up |

A Decision keeps this flow in either workflow setting; the resolution and time-spent validators do not apply to it. Once settled it is final.

An agent:

```sh
J='Content-Type: application/json'; A="Authorization: Basic $(printf agent:x | base64)"; U=http://127.0.0.1:4865/rest/api/3
curl -s -H "$A" -H "$J" $U/issue -d '{"fields":{"project":{"key":"SIM"},"issuetype":{"name":"Decision"},
  "summary":"Push feature/x to origin?","labels":["agent:my-agent"],
  "description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"3 commits, tests pass."}]}]}}}'
# → {"id":"10100","key":"SIM-1",...}; to tie it to a task: POST $U/issueLink, type Relates
curl -s -H "$A" "$U/issue/SIM-1?fields=resolution,comment"
# resolution null: it waits; Approved, Rejected, Answered or Cancelled: settled, and your reply is the last comment
```

What waits for you: `issuetype = Decision AND resolution is EMPTY`. The source is the `agent:<source>` label; sign-in is unchanged.

Or in one command, which waits and gives the outcome as its exit code (0 approved, 1 rejected, 2 answered, 3 withdrawn or timed out, 4 failed):

```sh
jira-sim ask "Push feature/x to origin?" --agent claude-code --about SIM-12 --context notes.md --wait 30m
# stdout: "approved SIM-13", then your reply if there is one; --json prints { key, outcome, reply }
```

`ask` uses the REST API only: with `--url` (or `$JIRA_URL`), `--project`, `$JIRA_EMAIL` and `$JIRA_TOKEN` it asks a real Jira. On timeout, on Ctrl-C or on a failure once the decision exists, it withdraws it, so nothing stays waiting.

````

- [ ] **Step 4: README, the API and the state sections**

Replace:

```
The epic and task workflows are enforced: a client that skips a state gets "no transition", Done needs a resolution, and a task Done needs time spent.
```

with:

```
The epic and task workflows are enforced: a client that skips a state gets "no transition", Done needs a resolution, and a task Done needs time spent. A Decision has its own flow ([Decisions](#decisions)).
```

Replace:

```
An empty database is seeded as an empty project, and **reset** empties it again (the settings stay).
```

with:

```
An empty database is seeded as an empty project, and **reset** empties it again (the settings stay). A state written by an older version is read with the issue types and resolutions added since (the Decision type, the Answered resolution), without a write.
```

- [ ] **Step 5: AGENTS.md**

In `AGENTS.md`, replace:

```
- `seed.ts`: the starting state — an empty project with its workflow metadata, the three simulated users and the settings. `--project <key>` names the project (`SIM` by default). No sample data: nothing internal is seeded, and it stays that way.
```

with:

```
- `seed.ts`: the starting state — an empty project with its workflow metadata, the three simulated users and the settings. `--project <key>` names the project (`SIM` by default). No sample data: nothing internal is seeded, and it stays that way. `withSeedWorkflow` completes the metadata a storage returns with the issue types and resolutions the seed gained since it was written; the server reads every context through it, so old databases need no migration and the storages no change.
```

Replace:

```
- `types.ts`: the state, the epic and task workflows, settings and faults.
```

with:

```
- `types.ts`: the state, the epic, task and decision workflows, settings and faults. A `Decision` (what agents ask you) goes `Open` → `Done` by Approve, Reject, Answer (comment required) or Withdraw, each setting its own resolution (`SimTransition.resolution`); it keeps this flow in the free workflow, and the resolution and time-spent validators skip it.
- `ask.ts`: `jira-sim ask`, a REST v3 client that creates a Decision and waits for it. Only `cli.ts` loads it, and it imports `jiraFormat` and `types` only (`scripts/check-boundaries.js`).
```

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs(readme): decisions, the decisions tab and jira-sim ask

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HCphy6iTgRd5Ny1DkgV9rf"
```

---

### Task 6: MongoDB and PostgreSQL

The Decision rules live in the server and the completion is read-time, so the backends need no change; this checks it. Skip a backend if Docker cannot run it here, and say so in the report.

- [ ] **Step 1: MongoDB**

```bash
docker compose up -d mongo
npm run compile
```

Start in the background (Bash `run_in_background`): `node out/cli.js --port 4867 --mongo mongodb://127.0.0.1:27017/jira-sim-smoke`

Run: `node .simulator/smoke/decisions.mjs http://127.0.0.1:4867`
Expected: `decisions smoke: ok`.

Stop the simulator, then drop the smoke database: `docker compose exec mongo mongosh --quiet jira-sim-smoke --eval 'db.dropDatabase()'`, then `docker compose down` (not `-v`: the volume may hold the user's data).

- [ ] **Step 2: PostgreSQL**

```bash
docker run --rm -d --name jira-sim-pg-smoke -e POSTGRES_PASSWORD=sim -e POSTGRES_DB=jira-sim-smoke -p 127.0.0.1:55432:5432 postgres:17
until docker exec jira-sim-pg-smoke pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
```

Start in the background: `node out/cli.js --port 4868 --postgres postgres://postgres:sim@127.0.0.1:55432/jira-sim-smoke`

Run: `node .simulator/smoke/decisions.mjs http://127.0.0.1:4868`
Expected: `decisions smoke: ok`.

Stop the simulator, then `docker stop jira-sim-pg-smoke` (`--rm` removes it).

- [ ] **Step 3: Nothing to commit**

Run: `git status --short`
Expected: empty (the smoke scripts are under the git-ignored `.simulator/`).
