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