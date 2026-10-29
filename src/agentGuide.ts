// The agent guide the server serves at /llms.txt: how an agent asks the user a decision and reads the answer, in
// Markdown, with the simulator's own URL and project key. The transitions come from DECISION_FLOW, so the guide follows
// the code. Imports types only.
import { DECISION, DECISION_FLOW } from './types';

/** What each outcome tells the agent to do. */
const MEANING: Record<string, string> = {
  Approved: 'go ahead; the last comment, if any, adds a remark',
  Rejected: 'do not do it; the last comment, if any, says why',
  Answered: 'the last comment is the answer: follow it',
  Cancelled: 'withdrawn by the agent: nothing was decided'
};

export function agentGuide(o: { url: string; project: string }): string {
  const { url, project } = o;
  const withdraw = DECISION_FLOW.find((t) => t.resolution === 'Cancelled')!;
  const rows = DECISION_FLOW.map((t) => `| ${t.name} | ${t.id} | ${t.resolution} | ${t.needsComment ? 'needs a comment' : 'comment optional'} | ${MEANING[t.resolution!] ?? ''} |`);
  return `# Ask the user a decision

This Jira simulator, at ${url}, is where you ask the user to decide something and wait for the answer: approve, reject, or a free-text answer. A decision is a Jira issue of type \`${DECISION}\` in the project \`${project}\`, created and read through the standard Jira Cloud REST API v3. The user settles it in the dashboard's Decisions tab, ${url}/.

Ask when you need the user's go-ahead or input. Do not act on what a decision is about before it is settled.

## Authentication

Basic authentication; any credentials are accepted. Use a user name without an \`@\`, such as \`agent:x\` (header \`Authorization: Basic YWdlbnQ6eA==\`): an email address renames the simulated user after you.

## 1. Ask

\`POST ${url}/rest/api/3/issue\`

\`\`\`json
{
  "fields": {
    "project": { "key": "${project}" },
    "issuetype": { "name": "${DECISION}" },
    "summary": "Push feature/x to origin?",
    "labels": ["agent:<source>"],
    "description": { "type": "doc", "version": 1, "content": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "3 commits on feature/x, tests pass. Pushing opens the merge request." }] }
    ] }
  }
}
\`\`\`

- \`summary\`: the question, one line, at most 255 characters, answerable by yes, no or a short text.
- \`labels\`: \`agent:<source>\`, who asks (letters, digits, \`.\`, \`_\`, \`-\`; no spaces). The user filters by it.
- \`description\` (optional, Atlassian Document Format): what the user needs to decide: what and why, the options, the risk.

The answer is \`201\` with \`{ "id", "key", "self" }\`: keep the \`key\`, for example \`${project}-12\`.

To tie the decision to the issue it is about: \`POST ${url}/rest/api/3/issueLink\` with \`{ "type": { "name": "Relates" }, "inwardIssue": { "key": "<decision key>" }, "outwardIssue": { "key": "<issue key>" } }\`.

## 2. Wait for the answer

Poll every 3 to 5 seconds: \`GET ${url}/rest/api/3/issue/<key>?fields=resolution,comment\`

- \`fields.resolution\` is \`null\`: it still waits.
- \`fields.resolution.name\` is set: it is settled, and final.
- The user's reply is the last comment, \`fields.comment.comments[-1].body\` (Atlassian Document Format: the text is in the \`text\` nodes).

| Transition | id | Resolution | Comment | What it means for you |
|------------|----|------------|---------|-----------------------|
${rows.join('\n')}

A \`404\` means the decision was deleted: stop waiting. A \`5xx\`, a \`429\` or no answer: try again at the next poll.

## 3. Give up

When you no longer need the answer (you time out, you stop, the question is moot), withdraw it, so nothing waits for the user for nothing:

\`POST ${url}/rest/api/3/issue/<key>/transitions\` with \`{ "transition": { "id": "${withdraw.id}" } }\`

## In one command

If the \`jira-sim\` command is installed, it does all of the above and waits:

\`\`\`sh
jira-sim ask "Push feature/x to origin?" --agent <source> --url ${url} [--about <issue key>] [--context <file> | --context -] [--wait 30m] [--json]
\`\`\`

Exit code: \`0\` approved, \`1\` rejected, \`2\` answered, \`3\` withdrawn or timed out (on timeout it withdraws), \`4\` failed. Standard output: \`<outcome> <key>\`, then the reply; with \`--json\`, \`{ "key", "outcome", "reply" }\`.

## Rules

- One decision per question, and only what the user must decide.
- Wait for the resolution before acting on it: approved, go; rejected, do not; answered, follow the reply.
- A settled decision is final: to ask again, create a new one.
- What waits for the user: \`POST ${url}/rest/api/3/search/jql\` with \`{ "jql": "issuetype = ${DECISION} AND resolution is EMPTY", "fields": ["summary", "labels"] }\`.

## With curl

\`\`\`sh
A='Authorization: Basic YWdlbnQ6eA=='; J='Content-Type: application/json'
curl -s -H "$A" -H "$J" ${url}/rest/api/3/issue -d '{"fields":{"project":{"key":"${project}"},"issuetype":{"name":"${DECISION}"},"summary":"Push feature/x to origin?","labels":["agent:my-agent"]}}'
curl -s -H "$A" "${url}/rest/api/3/issue/<key>?fields=resolution,comment"
curl -s -H "$A" -H "$J" ${url}/rest/api/3/issue/<key>/transitions -d '{"transition":{"id":"${withdraw.id}"}}'
\`\`\`
`;
}
