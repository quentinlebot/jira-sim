# jira-sim — a local Jira simulator

A standalone [Jira Cloud](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) simulator: the REST API subset the [DevFactory VS Code extension](https://github.com/quentinlebot/vscode-plugin-devfactory) uses, with an epic and task workflow, Jira's validation and error shapes, injectable faults, a request log and a dashboard. It was born inside that extension and now lives here.

Nothing real is in it: it seeds one empty project (`SIM` by default — `--project <key>` names it) with three simulated users, and answers every request as the simulated "you". Use it to try every interaction of the extension safely before pointing it at a real Jira — or to test a Jira client without Jira.

## Install and run

```sh
npm install --global jira-sim     # the bin: jira-sim
jira-sim                          # state in memory, on http://127.0.0.1:4865
```

Or from source:

```sh
git clone https://github.com/quentinlebot/jira-sim && cd jira-sim
npm install
npm start                         # compiles, then runs with the state in .simulator/jira-state.json
```

```
Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
       jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->] [--url <url>] [--wait 30m] [--json]
                                    ask you a decision and wait for it (jira-sim ask --help)

  --state <file>     keep the state in a JSON file.
  --mongo <uri>      keep it in MongoDB, e.g. mongodb://127.0.0.1:27017/devfactory-sim (default: $MONGODB_URI).
                     An empty database is seeded as an empty project.
  --postgres <uri>   keep it in PostgreSQL, e.g. postgres://127.0.0.1:5432/devfactory-sim (default: $POSTGRES_URI).
                     An empty database is seeded as an empty project.
  --project <key>    the project key of the empty seed (default: SIM).
  --host <address>   address to listen on (default: $JIRA_SIM_HOST or 127.0.0.1; 0.0.0.0 in a container).
  --public-url <url> URL clients reach it at, for self links (default: $JIRA_SIM_PUBLIC_URL or http://127.0.0.1:<port>).

Without --state, --mongo or --postgres the state lives in memory and is lost on exit.
```

The port answers `/_sim/ping` with `{ "id": "devfactory-simulator", storage, project, issues }`: that is how the extension recognises one, whatever starts it.

## In VS Code (DevFactory)

Set `devfactory.dataSource` to `simulator`: the extension reuses a simulator already listening on `devfactory.simulator.port`, else starts `devfactory.simulator.command` detached and waits for it. Its default, `jira-sim --port {port} --state {state} --project {project}`, runs the npm package with the port, a state file in the extension's global storage and `devfactory.jira.project` as the project; `{port}`, `{state}` and `{project}` are filled in. With `dataSource` `jira` and `devfactory.baseUrl` on the simulator URL, any email and token exercise the same code path as a real Jira.

The dashboard's changes show in the extension after **Refresh**, like edits by a teammate in Jira; the extension's changes show on the dashboard live.

## Dashboard

`http://127.0.0.1:<port>/` — five tabs:

- **Decisions**: what agents ask you, oldest first, by source, with Approve, Reject and Answer (one text box for a comment, a reason or the answer); then the settled ones with their outcome and your reply. The tab and the page title count what waits. You answer as the simulated you. See [Decisions](#decisions).
- **Board**: the issues by status (decisions left out unless **Show decisions** is ticked), filters, and an issue panel to act as a teammate: transitions (with resolution and time spent), comments, work log, links, labels, assignee, description, history.
- **Requests**: every REST call with its status, time, error and bodies.
- **Faults**: token expired (401), no permission (403), rate limited (429), Jira down (503), dropped connection, slow Jira, refused create, transition, link or search; or a custom one.
- **Workflow & settings**: the conventions' epic and task workflows or a free one; validators (resolution and time spent on Done, tasks done before epic review, Epic Name required); latency; search page size, to exercise paging; who new issues are assigned to; reset (empty project), export, import.

## The API it implements

What the extension calls, with Jira's checks and messages: enhanced JQL search (`/rest/api/3/search/jql`, a JQL subset with Jira's errors, `nextPageToken` paging), issues (get, create, edit, delete), transitions, comments, worklogs, issue links, and `myself`. Basic authentication with any email and token signs in as the simulated you, named after the email it sends. The epic and task workflows are enforced: a client that skips a state gets "no transition", Done needs a resolution, and a task Done needs time spent. A Decision has its own flow ([Decisions](#decisions)).

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

## State: a file, MongoDB or PostgreSQL

One backend behind one interface (`src/storage.ts`): a JSON file (or memory), one collection per entity in MongoDB, one table per entity in PostgreSQL. Every change is one write; ids and issue numbers come from atomic counters; JQL is evaluated in memory over the issues read from the database, the same evaluator whatever the backend.

An empty database is seeded as an empty project, and **reset** empties it again (the settings stay). A state written by an older version is read with the issue types and resolutions added since (the Decision type, the Answered resolution), without a write. Credentials never appear in logs or the dashboard: the connection string is shown redacted.

### On MongoDB (docker compose)

```sh
docker compose up -d --build    # mongo + jira-sim, on 127.0.0.1:27017 and 4865 (MONGO_PORT, JIRA_SIM_PORT)
docker compose down -v          # stop and drop the data: the next start seeds the empty project again
```

Browse it with `mongosh mongodb://127.0.0.1:27017/devfactory-sim` or Compass. Collections: `issues` (unique `key`, `project`, `parent`), `comments`, `worklogs`, `changelog` (by `issueId`), `links`, `users`, `projects`, `metadata` (`workflow`, `settings`, `instance`), `faults`, `requestLog` (the last 500 calls with their bodies), `counters` (taken with `$inc`).

### On PostgreSQL

Any server of your own, and a database it may create the tables in:

```sh
docker run --rm -d -e POSTGRES_PASSWORD=sim -e POSTGRES_DB=devfactory-sim -p 127.0.0.1:5432:5432 postgres:17
jira-sim --postgres postgres://postgres:sim@127.0.0.1:5432/devfactory-sim
```

Tables (the database name is yours, `devfactory-sim` by default): `projects`, `metadata` (jsonb documents: `workflow`, `settings`, `instance`), `users`, `issues` (unique `key`; jsonb `description`, `labels`, `custom`), `comments`, `worklogs`, `changelog` (`prev`/`next`: `from`/`to` are reserved words), `links` (unique `type`+`inward`+`outward`), `faults`, `counters` (taken with `INSERT … ON CONFLICT … RETURNING`), `request_log`. A reset is one transaction: one cut short changes nothing.

The `mongodb` and `pg` drivers are optional dependencies: the simulator starts without them, and only the CLI loads them (`src/mongoStorage.ts`, `src/postgresStorage.ts`).

## Development

```sh
npm install                     # dev deps, plus the optional mongodb and pg drivers
npm run compile                 # check:boundaries, then tsc → out/
npm run check:boundaries        # scripts/check-boundaries.js: the import rules of src/
npm run watch                   # rebuild on change
```

`src/` is flat: `server.ts` (the HTTP server, the Jira subset), `jql.ts` (the JQL evaluator), `types.ts`, `storage.ts` (the `SimStorage` interface and the JSON file/memory backend), `mongoStorage.ts` and `postgresStorage.ts` (loaded only by `cli.ts`), `seed.ts` (the empty-project seed), `jiraFormat.ts` (ADF ↔ plain text). `media/simulator.html` is the dashboard: one page, no build. No sample data: the project starts empty, and the issues are yours.