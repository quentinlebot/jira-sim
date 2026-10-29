#!/usr/bin/env node
// The Jira simulator as its own process:
//   jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
//   jira-sim ask <question> --agent <source> [...]   an agent's decision, through the REST API only (ask.ts)
import { DEFAULT_PORT, JiraSimulator } from './server';
import { DEFAULT_PROJECT } from './seed';
import { describeStorage, SimStorage } from './storage';

const USAGE = `Usage: jira-sim [--port 4865] [--host 127.0.0.1] [--state <file.json> | --mongo <uri> | --postgres <uri>] [--project <key>] [--public-url <url>]
       jira-sim ask <question> --agent <source> [--about <KEY>] [--context <file|->] [--url <url>] [--wait 30m] [--json]
                                    ask you a decision and wait for it (jira-sim ask --help)

  --state <file>     keep the state in a JSON file.
  --mongo <uri>      keep it in MongoDB, e.g. mongodb://127.0.0.1:27017/devfactory-sim (default: $MONGODB_URI).
                     An empty database is seeded as an empty project.
  --postgres <uri>   keep it in PostgreSQL, e.g. postgres://127.0.0.1:5432/devfactory-sim (default: $POSTGRES_URI).
                     An empty database is seeded as an empty project.
  --project <key>    the project key of the empty seed (default: ${DEFAULT_PROJECT}).
  --host <address>   address to listen on (default: $JIRA_SIM_HOST or 127.0.0.1; 0.0.0.0 in a container).
  --public-url <url> URL clients reach it at, for self links (default: $JIRA_SIM_PUBLIC_URL or http://127.0.0.1:<port>).

Without --state, --mongo or --postgres the state lives in memory and is lost on exit. --state wins over $MONGODB_URI and $POSTGRES_URI.`;

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The storage the flags ask for: undefined means the JSON file (or memory) the server falls back to. */
async function storageFor(mongo: string | undefined, postgres: string | undefined, project: string): Promise<SimStorage | undefined> {
  try {
    // The drivers are loaded only here: nothing else in this repo needs them.
    if (mongo) {
      const { MongoStorage } = await import('./mongoStorage');
      return new MongoStorage(mongo, project);
    }
    if (postgres) {
      const { PostgresStorage } = await import('./postgresStorage');
      return new PostgresStorage(postgres, project);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      fail(`--${mongo ? 'mongo' : 'postgres'} needs its driver: run npm ci (it is an optional dependency).`);
    }
    throw e;
  }
  return undefined;
}

async function main() {
  // Loaded only for the subcommand: the simulator itself never needs the client.
  if (args[0] === 'ask') {
    const { ask } = await import('./ask');
    process.exit(await ask(args.slice(1)));
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const state = opt('state');
  const mongo = opt('mongo');
  const postgres = opt('postgres');
  if ([state, mongo, postgres].filter(Boolean).length > 1) { fail('Pick one of --state, --mongo and --postgres.'); }
  const project = opt('project') ?? DEFAULT_PROJECT;
  const port = Number(opt('port') ?? DEFAULT_PORT);
  const sim = new JiraSimulator({
    port,
    host: opt('host') ?? process.env.JIRA_SIM_HOST,
    publicUrl: opt('public-url') ?? process.env.JIRA_SIM_PUBLIC_URL,
    storage: await storageFor(mongo ?? process.env.MONGODB_URI, postgres ?? process.env.POSTGRES_URI, project),
    stateFile: state,
    project
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void sim.stop().then(() => process.exit(0), () => process.exit(1)));
  }

  try {
    await sim.start();
  } catch (e) {
    fail((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is already in use (another simulator?). Pick one with --port.` : `Cannot start the Jira simulator: ${e instanceof Error ? e.message : e}`);
  }
  const { project: key, issues } = await sim.summary();
  console.log(`Jira simulator on ${sim.url}  (project ${key}, ${issues} issues, state ${describeStorage(sim.storage)})`);
  console.log(`Dashboard: ${sim.url}/`);
  console.log('In VS Code: devfactory.dataSource "simulator" uses it on the same port; or "jira" with devfactory.baseUrl set to the URL and any email and token.');
}

void main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));