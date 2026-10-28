// The JQL the simulator understands: clauses joined by AND, OR, NOT and parentheses, the usual operators, a few
// functions and ORDER BY. Values are checked against the simulated project the way Jira checks them, with its messages.
import { SimIssue, SimState, STATUS_CATEGORIES, statusOf } from './types';

export class JqlError extends Error {}

type Tok = { t: 'word' | 'str' | 'op' | 'punct'; v: string; pos: number };

type Value =
  | { kind: 'lit'; v: string }
  | { kind: 'fn'; name: string; args: string[] }
  | { kind: 'empty' }
  | { kind: 'list'; items: Value[] };

type Node =
  | { kind: 'and'; a: Node; b: Node }
  | { kind: 'or'; a: Node; b: Node }
  | { kind: 'not'; a: Node }
  | { kind: 'clause'; field: string; op: string; value: Value };

export interface Query {
  where?: Node;
  orderBy: { field: string; desc: boolean }[];
}

const RESERVED = new Set(['AND', 'OR', 'NOT', 'IN', 'IS', 'EMPTY', 'NULL', 'ORDER', 'BY', 'ASC', 'DESC', 'WAS', 'CHANGED']);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; }
        v += src[j++];
      }
      if (j >= src.length) { throw new JqlError(`Error in the JQL Query: The quoted string '${v}' has not been completed. (line 1, character ${i + 1})`); }
      out.push({ t: 'str', v, pos: i });
      i = j + 1;
      continue;
    }
    const op = /^(!=|!~|>=|<=|=|~|>|<)/.exec(src.slice(i));
    if (op) { out.push({ t: 'op', v: op[1], pos: i }); i += op[1].length; continue; }
    if ('(),'.includes(c)) { out.push({ t: 'punct', v: c, pos: i }); i++; continue; }
    const w = /^[^\s=!~<>(),"']+/.exec(src.slice(i));
    if (!w) { throw new JqlError(`Error in the JQL Query: The character '${c}' is a reserved JQL character. You must enclose it in a string or use the escape '\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}' instead. (line 1, character ${i + 1})`); }
    out.push({ t: 'word', v: w[0], pos: i });
    i += w[0].length;
  }
  return out;
}

export function parseJql(src: string): Query {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const kw = (k: string) => toks[p]?.t === 'word' && toks[p].v.toUpperCase() === k;
  const punct = (v: string) => toks[p]?.t === 'punct' && toks[p].v === v;
  const fail = (expect: string): never => {
    const t = toks[p];
    throw new JqlError(t
      ? `Error in the JQL Query: Expecting ${expect} but got '${t.v}'. (line 1, character ${t.pos + 1})`
      : `Error in the JQL Query: Expecting ${expect} but reached the end of the query.`);
  };

  const atom = (): Value => {
    const t = peek();
    if (!t || t.t === 'op' || t.t === 'punct') { return fail('either a value, list or function'); }
    p++;
    if (t.t === 'word' && ['EMPTY', 'NULL'].includes(t.v.toUpperCase())) { return { kind: 'empty' }; }
    if (t.t === 'word' && punct('(')) {
      p++;
      const args: string[] = [];
      while (peek() && !punct(')')) {
        if (!punct(',')) { args.push(peek().v); }
        p++;
      }
      if (!peek()) { fail("')'"); }
      p++;
      return { kind: 'fn', name: t.v, args };
    }
    return { kind: 'lit', v: t.v };
  };

  const value = (op: string): Value => {
    if (op !== 'in' && op !== 'not in') { return atom(); }
    if (!punct('(')) {
      const single = atom();
      return single.kind === 'fn' ? single : fail("'('");
    }
    p++;
    const items: Value[] = [atom()];
    while (punct(',')) { p++; items.push(atom()); }
    if (!punct(')')) { fail("')'"); }
    p++;
    return { kind: 'list', items };
  };

  const clause = (): Node => {
    const f = peek();
    if (!f || (f.t !== 'word' && f.t !== 'str') || (f.t === 'word' && RESERVED.has(f.v.toUpperCase()))) { return fail('a field name'); }
    p++;
    let op: string;
    const t = peek();
    if (t?.t === 'op') { op = t.v; p++; } else if (kw('IN')) { op = 'in'; p++; } else if (kw('NOT')) {
      p++;
      if (!kw('IN')) { fail("'IN'"); }
      p++;
      op = 'not in';
    } else if (kw('IS')) {
      p++;
      if (kw('NOT')) { p++; op = 'is not'; } else { op = 'is'; }
    } else if (kw('WAS') || kw('CHANGED')) {
      throw new JqlError(`The Jira simulator does not support the '${t!.v.toUpperCase()}' history operator.`);
    } else {
      return fail('operator');
    }
    return { kind: 'clause', field: f.v, op, value: value(op) };
  };

  const not = (): Node => {
    if (kw('NOT')) { p++; return { kind: 'not', a: not() }; }
    if (punct('(')) {
      p++;
      const n = or();
      if (!punct(')')) { fail("')'"); }
      p++;
      return n;
    }
    return clause();
  };
  const and = (): Node => {
    let a = not();
    while (kw('AND')) { p++; a = { kind: 'and', a, b: not() }; }
    return a;
  };
  const or = (): Node => {
    let a = and();
    while (kw('OR')) { p++; a = { kind: 'or', a, b: and() }; }
    return a;
  };

  const where = toks.length && !kw('ORDER') ? or() : undefined;
  const orderBy: Query['orderBy'] = [];
  if (kw('ORDER')) {
    p++;
    if (!kw('BY')) { fail("'BY'"); }
    p++;
    do {
      if (punct(',')) { p++; }
      const f = peek();
      if (!f || f.t === 'op' || f.t === 'punct') { fail('a field name'); }
      p++;
      let desc = false;
      if (kw('DESC')) { desc = true; p++; } else if (kw('ASC')) { p++; }
      orderBy.push({ field: f.v, desc });
    } while (punct(','));
  }
  if (p < toks.length) { fail(where ? "either 'OR' or 'AND'" : 'a field name'); }
  return { where, orderBy };
}

// ---- evaluation ----

type Kind = 'project' | 'type' | 'status' | 'category' | 'user' | 'issue' | 'labels' | 'text' | 'date' | 'resolution';

const FIELDS: Record<string, { name: string; kind: Kind }> = {
  project: { name: 'project', kind: 'project' },
  issuetype: { name: 'issuetype', kind: 'type' }, type: { name: 'issuetype', kind: 'type' },
  status: { name: 'status', kind: 'status' },
  statuscategory: { name: 'statusCategory', kind: 'category' },
  assignee: { name: 'assignee', kind: 'user' }, reporter: { name: 'reporter', kind: 'user' },
  parent: { name: 'parent', kind: 'issue' }, 'epic link': { name: 'parent', kind: 'issue' }, 'cf[10014]': { name: 'parent', kind: 'issue' },
  key: { name: 'key', kind: 'issue' }, issuekey: { name: 'key', kind: 'issue' }, id: { name: 'key', kind: 'issue' },
  labels: { name: 'labels', kind: 'labels' }, label: { name: 'labels', kind: 'labels' },
  summary: { name: 'summary', kind: 'text' }, description: { name: 'description', kind: 'text' },
  text: { name: 'text', kind: 'text' }, comment: { name: 'comment', kind: 'text' },
  resolution: { name: 'resolution', kind: 'resolution' },
  created: { name: 'created', kind: 'date' }, createddate: { name: 'created', kind: 'date' },
  updated: { name: 'updated', kind: 'date' }, updateddate: { name: 'updated', kind: 'date' },
  resolved: { name: 'resolved', kind: 'date' }, resolutiondate: { name: 'resolved', kind: 'date' }
};

const OPS: Record<Kind, string[]> = {
  project: ['=', '!=', 'in', 'not in'],
  type: ['=', '!=', 'in', 'not in'],
  status: ['=', '!=', 'in', 'not in'],
  category: ['=', '!=', 'in', 'not in'],
  user: ['=', '!=', 'in', 'not in', 'is', 'is not'],
  issue: ['=', '!=', 'in', 'not in', 'is', 'is not', '>', '>=', '<', '<='],
  labels: ['=', '!=', 'in', 'not in', 'is', 'is not'],
  text: ['~', '!~', 'is', 'is not'],
  date: ['=', '!=', '>', '>=', '<', '<=', 'is', 'is not'],
  resolution: ['=', '!=', 'in', 'not in', 'is', 'is not']
};

/** What a query is checked and evaluated against: the project's metadata, its users and the issues searched. */
export type JqlContext = Pick<SimState, 'project' | 'issueTypes' | 'statuses' | 'users' | 'resolutions' | 'issues'>;

const SORTS: Record<string, (i: SimIssue, s: JqlContext) => string | number> = {
  key: (i) => keyNumber(i.key), issuekey: (i) => keyNumber(i.key), id: (i) => Number(i.id), rank: (i) => keyNumber(i.key),
  created: (i) => Date.parse(i.created), updated: (i) => Date.parse(i.updated),
  resolved: (i) => (i.resolutionDate ? Date.parse(i.resolutionDate) : 0),
  summary: (i) => i.summary.toLowerCase(), status: (i, s) => s.statuses.findIndex((x) => x.name === i.status),
  issuetype: (i) => i.type, type: (i) => i.type, assignee: (i, s) => s.users.find((u) => u.accountId === i.assignee)?.displayName ?? '',
  resolution: (i) => i.resolution ?? '', parent: (i) => i.parent ?? '', priority: () => 0
};

/** Compiles the query against the state: a filter and an order. Throws JqlError like Jira's 400 answers. */
export function compileJql(q: Query, state: JqlContext, me: string, now = Date.now()) {
  const fieldOf = (name: string) => {
    const f = FIELDS[name.toLowerCase()];
    if (!f) { throw new JqlError(`Field '${name}' does not exist or you do not have permission to view it.`); }
    return f;
  };

  const issueByRef = (ref: string, field: string) => {
    const i = state.issues.find((x) => x.key.toLowerCase() === ref.toLowerCase() || x.id === ref);
    if (!i) { throw new JqlError(`An issue with key '${ref}' does not exist for field '${field}'.`); }
    return i;
  };

  /** One value of a clause, resolved to what the issue's values are compared with. */
  const resolve = (v: Value, f: { name: string; kind: Kind }): (string | number | null)[] => {
    if (v.kind === 'list') { return v.items.flatMap((x) => resolve(x, f)); }
    if (v.kind === 'empty') { return [null]; }
    if (v.kind === 'fn') {
      const fn = v.name.toLowerCase();
      if (fn === 'currentuser' && f.kind === 'user') { return [me]; }
      if (f.kind === 'date' && ['now', 'startofday', 'endofday', 'startofweek', 'startofmonth'].includes(fn)) { return [dateFn(fn, v.args[0], now)]; }
      throw new JqlError(`The Jira simulator does not support the JQL function '${v.name}()' for the field '${f.name}'.`);
    }
    const lit = v.v;
    const lc = lit.toLowerCase();
    const missing = (): never => { throw new JqlError(`The value '${lit}' does not exist for the field '${f.name}'.`); };
    switch (f.kind) {
      case 'project': return [[state.project.key, state.project.name, state.project.id].some((x) => x.toLowerCase() === lc) ? state.project.key : missing()];
      case 'type': return [state.issueTypes.find((t) => t.name.toLowerCase() === lc || t.id === lit)?.name ?? missing()];
      case 'status': return [state.statuses.find((s) => s.name.toLowerCase() === lc || s.id === lit)?.name ?? missing()];
      case 'category': return [Object.values(STATUS_CATEGORIES).find((c) => c.key === lc || c.name.toLowerCase() === lc || String(c.id) === lit)?.key ?? missing()];
      case 'user': return [state.users.find((u) => [u.accountId, u.emailAddress, u.displayName].some((x) => x.toLowerCase() === lc))?.accountId ?? missing()];
      case 'issue': return [issueByRef(lit, f.name).key];
      case 'resolution': return lc === 'unresolved' ? [null] : [state.resolutions.find((r) => r.toLowerCase() === lc) ?? missing()];
      case 'date': return [dateValue(lit, now) ?? (() => { throw new JqlError(`Date value '${lit}' for field '${f.name}' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', 'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.`); })()];
      default: return [lc];
    }
  };

  /** The issue's values for a field: several for labels, none when the field is empty. */
  const valuesOf = (i: SimIssue, f: { name: string; kind: Kind }): (string | number)[] => {
    switch (f.name) {
      case 'project': return [state.project.key];
      case 'issuetype': return [i.type];
      case 'status': return [i.status];
      case 'statusCategory': return [statusOf(state, i.status).category];
      case 'assignee': return i.assignee ? [i.assignee] : [];
      case 'reporter': return i.reporter ? [i.reporter] : [];
      case 'parent': return i.parent ? [i.parent] : [];
      case 'key': return [i.key];
      case 'labels': return i.labels.map((l) => l.toLowerCase());
      case 'resolution': return i.resolution ? [i.resolution] : [];
      case 'created': return [Date.parse(i.created)];
      case 'updated': return [Date.parse(i.updated)];
      case 'resolved': return i.resolutionDate ? [Date.parse(i.resolutionDate)] : [];
      default: return [];
    }
  };

  const textOf = (i: SimIssue, field: string) => {
    const desc = i.descriptionText ?? '';
    const comments = i.comments.map((c) => c.text).join('\n');
    return (field === 'summary' ? i.summary : field === 'description' ? desc : field === 'comment' ? comments : `${i.summary}\n${desc}\n${comments}`).toLowerCase();
  };

  const compile = (n: Node): ((i: SimIssue) => boolean) => {
    if (n.kind === 'and') { const a = compile(n.a); const b = compile(n.b); return (i) => a(i) && b(i); }
    if (n.kind === 'or') { const a = compile(n.a); const b = compile(n.b); return (i) => a(i) || b(i); }
    if (n.kind === 'not') { const a = compile(n.a); return (i) => !a(i); }
    const f = fieldOf(n.field);
    if (!OPS[f.kind].includes(n.op)) { throw new JqlError(`The operator '${n.op.toUpperCase()}' is not supported by the '${f.name}' field.`); }
    if ((n.op === 'is' || n.op === 'is not') && n.value.kind !== 'empty') { throw new JqlError(`The operator '${n.op.toUpperCase()}' only supports EMPTY or NULL, not the value given for the field '${f.name}'.`); }
    if (f.kind === 'text') {
      if (n.op === 'is' || n.op === 'is not') { const empty = n.op === 'is'; return (i) => (textOf(i, f.name).trim() === '') === empty; }
      if (n.value.kind !== 'lit') { throw new JqlError(`The operator '${n.op}' requires a text value for the field '${f.name}'.`); }
      const words = n.value.v.toLowerCase().replace(/[*?]/g, '').split(/\s+/).filter(Boolean);
      const has = (i: SimIssue) => { const t = textOf(i, f.name); return words.every((w) => t.includes(w)); };
      return n.op === '~' ? has : (i) => !has(i);
    }
    const wanted = resolve(n.value, f);
    const wantsEmpty = wanted.includes(null);
    const set = wanted.filter((x): x is string | number => x !== null);
    const num = (x: string | number) => (f.kind === 'issue' ? keyNumber(String(x)) : Number(x));
    return (i) => {
      const vals = valuesOf(i, f);
      switch (n.op) {
        case 'is': return vals.length === 0;
        case 'is not': return vals.length > 0;
        case '=': case 'in':
          return (wantsEmpty && vals.length === 0) || vals.some((v) => set.includes(v));
        // Like Jira, != and NOT IN do not match issues where the field is empty.
        case '!=': case 'not in':
          return vals.length > 0 && !vals.some((v) => set.includes(v));
        default: {
          const target = num(set[0]);
          return vals.some((v) => {
            const x = num(v);
            return n.op === '>' ? x > target : n.op === '>=' ? x >= target : n.op === '<' ? x < target : x <= target;
          });
        }
      }
    };
  };

  if (!q.where) { throw new JqlError('Unbounded JQL queries are not allowed here. Please add a search restriction to your query.'); }
  const match = compile(q.where);
  const sorts = q.orderBy.length ? q.orderBy : [{ field: 'created', desc: true }];
  for (const s of sorts) {
    if (!SORTS[s.field.toLowerCase()]) { throw new JqlError(`Not able to sort using field '${s.field}'.`); }
  }
  const compare = (a: SimIssue, b: SimIssue) => {
    for (const s of sorts) {
      const get = SORTS[s.field.toLowerCase()];
      const x = get(a, state);
      const y = get(b, state);
      if (x !== y) { return (x < y ? -1 : 1) * (s.desc ? -1 : 1); }
    }
    return keyNumber(b.key) - keyNumber(a.key);
  };
  return { match, compare };
}

function keyNumber(key: string) {
  return Number(key.split('-').pop()) || 0;
}

const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "2026-10-01", "2026/10/01 12:30", or a period from now such as "-7d" or "-1w 2d". */
function dateValue(v: string, now: number): number | undefined {
  const abs = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v.trim());
  if (abs) { return new Date(+abs[1], +abs[2] - 1, +abs[3], +(abs[4] ?? 0), +(abs[5] ?? 0)).getTime(); }
  const rel = /^([-+]?)((?:\s*\d+[mhdw])+)$/.exec(v.trim());
  if (!rel) { return undefined; }
  const ms = [...rel[2].matchAll(/(\d+)([mhdw])/g)].reduce((s, m) => s + Number(m[1]) * UNIT[m[2]], 0);
  return now + (rel[1] === '-' ? -ms : ms);
}

function dateFn(fn: string, arg: string | undefined, now: number): number {
  const d = new Date(now);
  const shift = arg ? dateValue(arg, 0) ?? 0 : 0;
  switch (fn) {
    case 'startofday': d.setHours(0, 0, 0, 0); break;
    case 'endofday': d.setHours(23, 59, 59, 999); break;
    case 'startofweek': d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); break;
    case 'startofmonth': d.setHours(0, 0, 0, 0); d.setDate(1); break;
  }
  return d.getTime() + shift;
}
