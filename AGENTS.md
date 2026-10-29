# AGENTS.md

This file provides guidance to coding agents (Claude Code, Gemini CLI, Codex or any other) when working with code in this repository.

jira-sim: a standalone Jira Cloud simulator (TypeScript, no bundler, no runtime dependencies) — the REST API v3 subset the DevFactory VS Code extension uses, with an epic and task workflow, Jira's validation and error shapes, injectable faults, a request log and a dashboard. Born inside vscode-plugin-devfactory (its `src/simulator`), now its own package. `README.md` is the user-facing reference; it is updated alongside behaviour changes.

## Commands

```sh
npm install                 # dev deps; also the optional mongodb and pg drivers (CLI only)
npm run compile             # check:boundaries, then tsc → out/  (strict; no test suite, no linter)
npm run check:boundaries    # scripts/check-boundaries.js: the import rules of src/
npm run watch                # rebuild on change
npm start                   # compile, then run on 127.0.0.1:4865, state in .simulator/jira-state.json
node out/cli.js --port 4865 [--state file | --mongo uri | --postgres uri] [--project key] [--host addr] [--public-url url]

docker compose up -d --build   # mongo + jira-sim (compose.yaml, Dockerfile); down -v drops the data
npm pack                     # prepack builds out/; this is not a VS Code extension, no vsce
```

## Architecture

Everything lives in `src/`, flat, compiled to `out/` by one build (`tsconfig.json`, `rootDir` src, `outDir` out). `out/cli.js` is the npm bin (`jira-sim`) and the Docker entry point; `out/server.js` is the library entry.

- `server.ts` (`JiraSimulator`): the HTTP server. `/rest/api/3/*` is the Jira subset (search with JQL, issues, transitions, comments, worklogs, links, `myself`), with Jira's validation and error shapes; `/_sim/api/*`, `/_sim/ping` and `/_sim/events` (SSE) are the dashboard's; `/llms.txt` is the agent guide (`agentGuide.ts`, imports `types` only: how an agent asks a decision, with the live URL and project key and the transitions of `DECISION_FLOW`). The dashboard page is `media/simulator.html`, served by the server. The server only touches the state through `SimStorage`, one call per read or write — the storage backends are interchangeable.
- `jql.ts`: the JQL evaluator (parse, check, compile), with Jira's error messages. JQL is always evaluated in memory over the issues read from the storage.
- `storage.ts`: the `SimStorage` interface and `FileStorage` (a JSON file, or memory without a file, seeded from `seed.ts`).
- `mongoStorage.ts` / `postgresStorage.ts`: the same interface on MongoDB and PostgreSQL — one collection/table per entity, atomic counters, every change one write. Invariants:
  - Nothing but `cli.ts` loads them (with a dynamic `import()`), and only they import their driver (`mongodb`, `pg`). `scripts/check-boundaries.js` (first step of `npm run compile`) enforces this on direct imports; with these rules the server's closure cannot reach the CLI or the drivers.
  - The drivers are `optionalDependencies`: the simulator runs without them, and only the flags that need them (`--mongo`, `--postgres`) fail when they are missing.
  - No `vscode` import anywhere: this runs in plain node and in Docker.
  - An empty database (or one whose state was cut short: the `instance` marker row is written last) is seeded on the next start. A reset is a full replacement; with PostgreSQL it is one transaction.
  - Credentials in a connection string never reach logs or the dashboard: both storages show a redacted location.
- `seed.ts`: the starting state — an empty project with its workflow metadata, the three simulated users and the settings. `--project <key>` names the project (`SIM` by default). No sample data: nothing internal is seeded, and it stays that way. `withSeedWorkflow` completes the metadata a storage returns with the issue types and resolutions the seed gained since it was written; the server reads every context through it, so old databases need no migration and the storages no change.
- `jiraFormat.ts`: ADF ↔ plain text, a trimmed copy of the extension's module.
- `types.ts`: the state, the epic, task and decision workflows, settings and faults. A `Decision` (what agents ask you) goes `Open` → `Done` by Approve, Reject, Answer (comment required) or Withdraw, each setting its own resolution (`SimTransition.resolution`); it keeps this flow in the free workflow, and the resolution and time-spent validators skip it.
- `ask.ts`: `jira-sim ask`, a REST v3 client that creates a Decision and waits for it. Only `cli.ts` loads it, and it imports `jiraFormat` and `types` only (`scripts/check-boundaries.js`).

The DevFactory extension finds a running simulator through `/_sim/ping` (it answers `id: "devfactory-simulator"`); when none answers it starts its `devfactory.simulator.command`. Keep that ping contract and the CLI flags stable.

## Conventions

- Commits: conventional commits with a scope when one fits, lowercase imperative summary, e.g. `feat(storage): …`, `fix(jql): …`, `docs(readme): …`, `chore(release): bump version to …`.
- Code comments are short sentences that say why. Each module opens with a header comment stating its role and its dependency constraints.
- New CLI flags or storages go in `README.md` (usage block and the state section), and in the `USAGE` string of `cli.ts`.
- Nothing internal goes in this repository: no company or project names, no sample data, no credentials. The seed stays an empty project.
- The dashboard (`media/simulator.html`) is one page with no build and no external assets; keep it self-contained.