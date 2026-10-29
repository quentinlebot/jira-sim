// The simulator's starting state: an empty project with its workflow metadata, the users to act as, and the settings.
// No sample data: the issues start with yours.
import { DEFAULT_SETTINGS, RESOLUTIONS, SimState, STATUSES } from './types';

/** The project key an empty database is seeded with when --project does not name one. */
export const DEFAULT_PROJECT = 'SIM';

export function seedState(project = DEFAULT_PROJECT): SimState {
  return {
    version: 1,
    project: { id: '10000', key: project, name: project },
    statuses: STATUSES.map((s) => ({ ...s })),
    issueTypes: [
      { id: '10000', name: 'Epic', hierarchyLevel: 1 },
      { id: '10001', name: 'Task', hierarchyLevel: 0 },
      { id: '10002', name: 'Bug', hierarchyLevel: 0 },
      { id: '10003', name: 'Story', hierarchyLevel: 0 },
      { id: '10004', name: 'Sub-task', hierarchyLevel: -1 },
      { id: '10005', name: 'Decision', hierarchyLevel: 0 }
    ],
    resolutions: [...RESOLUTIONS],
    linkTypes: [
      { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '10001', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
      { id: '10002', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
      { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' }
    ],
    users: [
      { accountId: 'sim-me', displayName: 'You', emailAddress: 'you@simulator.local' },
      { accountId: 'sim-sam', displayName: 'Sam Rivera', emailAddress: 'sam.rivera@simulator.local' },
      { accountId: 'sim-noor', displayName: 'Noor Haddad', emailAddress: 'noor.haddad@simulator.local' }
    ],
    /** The account every API call is made as, whatever its credentials. */
    me: 'sim-me',
    nextId: 10100,
    nextNumber: 1,
    issues: [],
    links: [],
    settings: { ...DEFAULT_SETTINGS },
    faults: []
  };
}

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