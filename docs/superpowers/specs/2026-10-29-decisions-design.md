# Decisions: agents ask, you settle them in the simulator

Date: 2026-10-29

## Goal

Agents of any source (the DevFactory extension, Claude Code, a script, CI) put items that wait for you into the simulator: something to approve, to reject, or a question to answer. You settle them from the dashboard, from any device that reaches it, and each agent reads your answer back. A decision is a plain Jira issue, so an agent uses the standard REST v3 and the same flow works against a real Jira configured the same way.

## Decisions taken

- A decision is a Jira issue of type `Decision`, in the simulator's one project (no multi-project support).
- Three outcomes for every decision: approve, reject (optional reason), answer (free text). No agent-defined options.
- Agents learn the outcome by polling. No webhooks.
- The source is a label `agent:<source>`. Sign-in is unchanged: every client is the simulated "you".
- The workflow reuses `Open` and `Done`; the outcome is the resolution.
- A `jira-sim ask` subcommand asks and waits in one command.

## 1. Model and workflow

`types.ts` and `seed.ts`:

- Issue type `Decision`: id `10005`, `hierarchyLevel` 0.
- Resolution `Answered` added to `RESOLUTIONS`. `Approved`, `Rejected` and `Cancelled` already exist.
- `DECISION_FLOW`, four transitions from `Open` to `Done`. Each transition sets its own resolution, as a Jira post-function would; a `resolution` field in the request is ignored for a Decision:

  | id | name     | resolution | rule                                                         |
  |----|----------|------------|--------------------------------------------------------------|
  | 91 | Approve  | Approved   | comment optional                                             |
  | 92 | Reject   | Rejected   | comment optional (the reason)                                |
  | 93 | Answer   | Answered   | requires a comment in `update.comment`; without one, a 400 with Jira's error shape: `errors.comment` "Comment is required." |
  | 94 | Withdraw | Cancelled  | used by the agent that gives up                              |

- `SimTransition` gets an optional `resolution` field, which only `DECISION_FLOW` sets.
- `transitionsOf` returns `DECISION_FLOW` for a Decision whatever `settings.workflow` is: the "free" setting governs epics and tasks only.
- The resolution-required and time-spent validators do not apply to a Decision.
- No reopen: a settled decision is final. An agent that needs another answer creates another decision.

### Existing databases

The workflow metadata (statuses, issue types, resolutions, link types) is stored with the state, and only an empty database is seeded. At startup, each storage (`FileStorage`, `MongoStorage`, `PostgresStorage`) adds the issue types and resolutions of the seed that its stored metadata lacks, in one write, and leaves everything else as it is. The merge is one function in `seed.ts` (`upgradeWorkflow`), shared by the three storages.

## 2. The contract for agents

1. Create: `POST /rest/api/3/issue` with
   - `project: {key}`, `issuetype: {name: "Decision"}`;
   - `summary`: the question;
   - `description` (ADF): the context, such as a diff, a plan or links;
   - `labels: ["agent:<source>"]`.

   To tie it to the task it is about: `POST /rest/api/3/issueLink`, type `Relates`, between the decision and the task.
2. Wait: poll `GET /rest/api/3/issue/KEY?fields=resolution,comment`.
   - `resolution` null: still waiting.
   - `Approved`, `Rejected`, `Answered` or `Cancelled`: settled. Your reply is the last comment written after the decision was created (if any).
3. Give up: `POST /rest/api/3/issue/KEY/transitions` with `{"transition": {"id": "94"}}`.

What waits for you: `issuetype = Decision AND resolution is EMPTY` (the JQL evaluator already supports `is EMPTY` on `resolution`).

## 3. Dashboard (`media/simulator.html`)

The dashboard already reads every issue and updates live over `/_sim/events`. No new server endpoint: its buttons call the same transitions as the issue panel.

- A **Decisions** tab, first in the tab bar, labelled with the count still waiting (`Decisions 3`). The page title carries it too (`(3) jira-sim`).
- **Waiting**: oldest first, with a filter by source (the `agent:*` labels) and a count per source. Each card shows:
  - the key, the source, how long it has waited, the question;
  - the description, rendered as on the issue panel;
  - the related issue, if there is one, which opens its panel on the Board;
  - **Approve** (an optional comment), **Reject…** (an optional reason), **Answer…** (text required: the button stays disabled while the text is empty).
- **Settled**: the most recent ones, with their outcome (Approved, Rejected, Answered, Withdrawn) and your reply, with the same filter. Read only.
- A decision withdrawn while you read it moves to Settled. If you click it anyway, the 400 is shown in its card, the way errors show elsewhere.
- The **Board** leaves Decisions out by default; a filter option shows them. They remain ordinary issues: the issue panel, JQL and the Requests tab treat them like any other.
- Left out: browser notifications, sounds, assigning decisions to teammates.

## 4. `jira-sim ask`

```
jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->]
             [--url <url>] [--project <key>] [--wait <duration>] [--json]
```

- Creates the decision, as section 2 describes. `--context` is a file (or `-` for stdin), converted to ADF with `textToAdf`. `--about` links it to an issue (`Relates`).
- Polls every 3 seconds until it is settled or `--wait` runs out (default `30m`; `0` waits without a limit). On timeout it withdraws the decision itself, so nothing stays waiting.
- Prints the outcome and your reply; `--json` prints `{ key, outcome, reply }`.
- Exit codes: `0` approved, `1` rejected, `2` answered (the reply on stdout), `3` withdrawn or timed out. Any other failure (unreachable, refused) exits `4` with the error on stderr.
- `--url` defaults to `http://127.0.0.1:4865`. `--project` defaults to the project `/_sim/ping` reports; against a real Jira (no ping) it is required.
- Credentials: `JIRA_EMAIL` and `JIRA_TOKEN` when set. Otherwise, against the simulator, the user `jira-sim-ask` with no `@`: the simulator's sign-in only renames "you" after an email that has one, so `ask` never renames you.
- Only REST v3, through node's `fetch` (node 18+).
- Module `src/ask.ts`, loaded only by `cli.ts`. `scripts/check-boundaries.js` gets a rule: `ask.ts` may import `jiraFormat` and `types` only, never the server or the storages. The existing rule already stops anything from importing the CLI.

## 5. Docs

- `README.md`: a "Decisions" section with the contract and a curl example; the Decisions tab in the Dashboard list; `ask` in the usage block.
- `cli.ts`: `ask` in the `USAGE` string.
- `AGENTS.md`: the Decision flow, the startup upgrade and `ask.ts` in Architecture.

## 6. Verification

The repository has no test suite.

- `npm run compile`, which checks the import rules first.
- A smoke script in the scratchpad against an in-memory simulator:
  - create → Approve, Reject, Withdraw;
  - Answer without a comment (expect the 400), then with one;
  - the JQL `issuetype = Decision AND resolution is EMPTY` before and after;
  - a Decision under the "free" workflow still offers only its four transitions.
- The startup upgrade, on a state file written before this change.
- The Decisions tab in a browser, light and dark, at phone width.
- `jira-sim ask`: every exit code, the timeout that withdraws, `--json`.
- MongoDB and PostgreSQL through `docker compose` (and a `postgres` container), if Docker is available here.
