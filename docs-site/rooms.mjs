// The starting points and roles of the site, one "room" page each. pages.mjs
// writes each room as src/content/docs/for/<id>.mdx, served at
// /sql-yodeler/for/<id>/, with the same sections in the same order: the lede,
// Works, Differs (per dialect and per forge), First step, Proof (the room's
// claims from scenarios/claims-record.json) and Then read. The home page's
// picker reads the same lists.
//
// A link's href is a docs page's slug (its file name in docs/ without .md),
// with an anchor when it points into the page, or a full https:// address.
// The site build fails when a room links a page or anchor that does not
// exist, or names a claim the record does not have.
//
// Room text never names another migration tool.

import { setupPrompt } from './prompts.mjs';

/** @typedef {{ label: string, href: string }} Link */

/** The starting points: the four tiles on the home page. */
export const STARTS = [
	{ id: 'new-schema', label: 'Start a new schema', blurb: 'template, then first migration', room: 'new-schema' },
	{ id: 'adopt', label: 'Adopt a live database', blurb: 'yodel init --from <env>', room: 'adopt' },
	{ id: 'lint-and-plan', label: 'Lint and plan on pull requests', blurb: 'yodel lint and the plan comment, no apply yet', room: 'lint-and-plan' },
	{ id: 'coming-from', label: 'Coming from another tool', blurb: 'concepts mapped, then init --from', room: 'coming-from' },
];

/** The roles: the line under the tiles. */
export const ROLES = [
	{ id: 'platform', label: 'I set up CI for many teams', room: 'platform' },
	{ id: 'agents', label: 'I work with a coding agent', room: 'agents' },
	{ id: 'security', label: 'I review security', room: 'security' },
	{ id: 'evaluate', label: 'I am evaluating', room: 'evaluate' },
];

/** The dialects: what each adds to a room, what differs on it, and its starter template. */
export const DIALECTS = [
	{
		id: 'clickhouse',
		label: 'ClickHouse',
		record: 'ch',
		works: [
			'Sort-key and engine changes as rebuilds into a new table, swapped in by the migration',
			'Backfills that run once inside a migration, and resume if stopped',
			'A single node, a cluster, a Replicated database or ClickHouse Cloud',
		],
		differs: [
			'A project owns ClickHouse databases (`yodel create <dir> --clickhouse --database <name>`).',
			'A rebuild keeps the old table until `yodel cleanup` drops it, and lint flags mutations and rebuilds (`ch-mutation`, `ch-rebuild`).',
		],
		template: { path: 'templates/clickhouse', params: '--clickhouse --database events' },
	},
	{
		id: 'postgres',
		label: 'Postgres',
		record: 'pg',
		works: [
			'Column changes as `PostgresMigrationOp` expand-and-contract steps',
			'Row-level security, policies and grants declared with the schema',
			'Lint that flags statements which rewrite a table or hold a long lock',
		],
		differs: [
			'A project owns Postgres schemas (`yodel create <dir> --postgres --schema <name>`).',
			"Roles stay the environment's: the schema declares the policies and grants that name them.",
		],
		template: { path: 'templates/postgres', params: '--postgres --schema app' },
	},
];

/** The forges `yodel ci` renders pipelines for, and what differs on each. */
export const FORGES = [
	{
		id: 'github',
		label: 'GitHub',
		differs: [
			"The writer's secrets are secrets of a GitHub environment limited to `main`.",
			"The plan comment and the drift issue use the job's own token.",
		],
	},
	{
		id: 'gitlab',
		label: 'GitLab',
		differs: [
			"The writer's variables are protected and scoped to the environment; the readers' are not protected.",
			'The plan comment and the drift issue need `GITLAB_TOKEN`, and each drift watch runs from a pipeline schedule you create.',
		],
	},
	{
		id: 'forgejo',
		label: 'Forgejo',
		differs: [
			'Secrets belong to the repository, with no environments, so limit who can push branches.',
			'Jobs need a runner with the `docker` label, and a job gets no OIDC token for cloud roles.',
		],
	},
];

const template = (d) => `npx @intentius/sql-yodeler@latest create my-schema ${d.template.params}`;
const [clickhouse, postgres] = DIALECTS;

/**
 * The rooms, one per start and role. `differs` adds lines to a dialect's or
 * forge's own (by its id); `first.command` is per dialect, or `any` for both,
 * in a `sh` block unless `first.lang` names another; `first.note` comes before it.
 */
export const ROOMS = [
	{
		id: 'new-schema',
		title: 'Start a new schema',
		lede: 'For a team starting a schema from nothing: declare it in TypeScript in a project from a starter template, and yodel writes the first migration from it on a local database.',
		works: [
			'A project with a profile, a migrate Op and a drift watch per environment, and pipelines for GitHub, GitLab and Forgejo',
			'The first migration written from `src/schema.ts`, planned, approved and applied on chant\'s local emulator',
			'Lint, the replay check and a plan comment on every pull request',
		],
		differs: {},
		first: {
			command: { clickhouse: template(clickhouse), postgres: template(postgres) },
			link: { label: 'Your first migration', href: 'getting-started' },
		},
		claims: ['migrations', 'approval', 'declarative'],
		tasks: [
			{ label: 'Your first migration', href: 'getting-started' },
			{ label: 'Setting up each forge', href: 'forges' },
		],
		background: [
			{ label: 'Declaring the schema', href: 'schema' },
			{ label: 'The two workflows', href: 'workflows' },
			{ label: 'Migrations', href: 'migrations' },
			{ label: 'Approval', href: 'approval' },
		],
		reference: [
			{ label: 'The commands', href: 'cli' },
			{ label: 'Installing and configuring', href: 'configuration' },
			{ label: 'Glossary', href: 'glossary' },
		],
	},
	{
		id: 'adopt',
		title: 'Adopt a live database',
		lede: 'For a team whose database already exists: read it into declarations and a baseline migration, then change it only through migrations.',
		works: [
			'`yodel init --from <env>` reads the live database into `src/` and plans it back to no change before it writes anything',
			'A baseline migration recorded as applied, with none of its statements run',
			'Access adopted with the tables when the environment manages it: policies and grants, and on ClickHouse users and roles',
			'`yodel init --baseline` for another environment that holds the same schema',
		],
		differs: {},
		first: {
			command: { any: 'YODEL_CREDENTIALS=writer npx yodel init --from <env> --force' },
			link: { label: 'Adopting an existing database', href: 'adoption#adopting-an-existing-database-yodel-init-from' },
		},
		claims: ['declarative'],
		tasks: [
			{ label: 'Starting a project', href: 'adoption' },
			{ label: 'Setting up each forge', href: 'forges' },
		],
		background: [
			{ label: 'The two workflows', href: 'workflows' },
			{ label: 'Access control', href: 'access#adopting-a-database' },
		],
		reference: [
			{ label: 'The commands', href: 'cli' },
			{ label: 'Installing and configuring', href: 'configuration' },
		],
	},
	{
		id: 'lint-and-plan',
		title: 'Lint and plan on pull requests',
		lede: 'For a team that wants every migration reviewed in its pull request before SQL Yodeler applies anything.',
		works: [
			'`yodel lint` and the replay check on every pull request, with no database credentials',
			'A plan comment per environment, made with read-only credentials, and a write probe that fails the job if they can write',
			'The drift watch on its schedule, with a tracking issue',
			'No apply pipeline and no writer in CI until you turn apply on',
		],
		differs: {},
		first: {
			note: 'Set `ci: { forges: ["github", "gitlab", "forgejo"], apply: false }` in `yodel.config.ts`, then render the pipelines:',
			command: { any: 'npm run ci' },
			link: { label: 'Lint and plan on pull requests only', href: 'lint-and-plan' },
		},
		claims: ['migrations', 'approval'],
		tasks: [
			{ label: 'Lint and plan on pull requests only', href: 'lint-and-plan' },
			{ label: 'Setting up each forge', href: 'forges' },
		],
		background: [
			{ label: 'Lint', href: 'lint' },
			{ label: 'The pull request comment', href: 'approval#the-pull-request-comment' },
			{ label: 'Drift', href: 'drift' },
		],
		reference: [
			{ label: 'The commands', href: 'cli' },
			{ label: 'The lint rules', href: 'lint#the-rules' },
		],
	},
	{
		id: 'coming-from',
		title: 'Coming from another tool',
		lede: 'For a team whose database another migration tool manages today: the concepts mapped, then the database adopted with init --from.',
		works: [
			'Each concept of a numbered-files migration tool mapped to its SQL Yodeler counterpart',
			"The database adopted as it is, with the old tool's history table left out",
			'Rollback with `yodel revert`, planned from the recorded schema, behind the same approval',
			'A migration that fails part way resumes where it stopped; one out of order is refused',
		],
		differs: {},
		first: {
			command: { any: 'YODEL_CREDENTIALS=writer npx yodel init --from <env> --force' },
			link: { label: 'Coming from another migration tool', href: 'from-other-tools' },
		},
		claims: ['declarative', 'resume', 'migrations'],
		tasks: [
			{ label: 'Coming from another migration tool', href: 'from-other-tools' },
			{ label: 'Cutting CI over', href: 'from-other-tools#cutting-ci-over' },
			{ label: 'Setting up each forge', href: 'forges' },
		],
		background: [
			{ label: 'Migrations', href: 'migrations' },
			{ label: 'Data migrations', href: 'steps' },
		],
		reference: [
			{ label: 'The commands', href: 'cli' },
			{ label: 'Glossary', href: 'glossary' },
		],
	},
	{
		id: 'platform',
		title: 'Setting up CI for many teams',
		lede: 'For a platform team that runs the pipelines of many schema projects: one renderer, the same jobs on each forge, and a pinned image.',
		works: [
			'`yodel ci` renders every project\'s pipelines from the installed package, and `yodel ci --check` fails a pipeline edited by hand or not rendered again',
			'`ci.forges` picks GitHub, GitLab or Forgejo, and `ci.jobs` keeps a project\'s own jobs across renders',
			'`ci.image` runs every job in the CI image, pinned by its digest',
			'Waves: one environment after another, each behind its own gate',
		],
		differs: {},
		first: {
			command: { any: 'npm run ci' },
			link: { label: 'The pipelines: yodel ci', href: 'workflows#the-pipelines-yodel-ci' },
		},
		claims: ['waves', 'forge'],
		tasks: [
			{ label: 'Setting up each forge', href: 'forges' },
			{ label: 'Lint and plan on pull requests only', href: 'lint-and-plan' },
		],
		background: [
			{ label: 'The pipelines: yodel ci', href: 'workflows#the-pipelines-yodel-ci' },
			{ label: 'Waves: a gate per environment', href: 'approval#waves-a-gate-per-environment' },
			{ label: 'Least privilege on each forge', href: 'configuration#least-privilege-on-each-forge' },
		],
		reference: [
			{ label: 'yodel.config.ts', href: 'configuration#yodelconfigts' },
			{ label: 'The commands', href: 'cli' },
		],
	},
	{
		id: 'agents',
		title: 'Working with a coding agent',
		lede: 'For someone who hands SQL Yodeler\'s setup to a coding agent, and keeps approvals and applies for people.',
		works: [
			'One prompt that sets SQL Yodeler up in a repository and opens a pull request, and stops short of applying, approving or merging',
			'`yodel mcp`: read-only tools for status, plan, lint and drift',
			'JSON Schemas for the `--json` output of each command',
			'llms.txt and a prompt on each task page',
		],
		differs: {},
		first: {
			note: 'Hand the agent this prompt:',
			command: { any: setupPrompt },
			lang: 'text',
			link: { label: 'Set up with a coding agent', href: 'agents' },
		},
		claims: [],
		tasks: [
			{ label: 'Set up with a coding agent', href: 'agents' },
			{ label: 'Your first migration', href: 'getting-started' },
		],
		background: [
			{ label: 'Rules for the agent', href: 'agents#rules-for-the-agent' },
			{ label: 'Approval', href: 'approval' },
		],
		reference: [
			{ label: 'Read-only tools (yodel mcp)', href: 'agents#read-only-tools-yodel-mcp' },
			{ label: 'JSON output', href: 'cli#json-output' },
			{ label: 'Exit codes', href: 'cli#exit-codes' },
		],
	},
	{
		id: 'security',
		title: 'Security review',
		lede: 'What each job can reach, who can approve an apply, and the record every change leaves.',
		works: [
			'A reader and a writer per environment: only the apply wave holds the writer, and a write probe fails a pull request job that can write',
			'Each approval bound to a digest of the plan; when the plan moves, the approval no longer holds',
			'Approval modes, including approvals sealed with a signer listed in the repository',
			'An audit log derived from the history and the gate ledger',
		],
		differs: {},
		first: {
			command: { any: 'npx yodel config check <env> --write-probe' },
			link: { label: 'Credentials: a reader and a writer', href: 'configuration#credentials-a-reader-and-a-writer' },
		},
		claims: ['approval', 'waves'],
		tasks: [
			{ label: 'Setting up each forge', href: 'forges' },
			{ label: 'Access control', href: 'access' },
		],
		background: [
			{ label: 'Approval modes', href: 'approval#approval-modes-which-approvals-count' },
			{ label: 'Sealed approvals', href: 'approval#sealed-approvals' },
			{ label: 'The plan digest', href: 'approval#the-plan-digest' },
			{ label: 'The audit log', href: 'audit#the-audit-log' },
		],
		reference: [
			{ label: 'Least privilege on each forge', href: 'configuration#least-privilege-on-each-forge' },
			{ label: 'yodel config check', href: 'configuration#yodel-config-check' },
			{ label: 'Claims status', href: 'claims' },
		],
	},
	{
		id: 'evaluate',
		title: 'Evaluating SQL Yodeler',
		lede: 'For someone deciding whether SQL Yodeler fits: two finished example projects, the claims that run against real servers, and a first migration on a local database.',
		works: [
			'Two example projects, one per dialect, whose READMEs are transcripts of real runs',
			'Scenario claims that run each feature against a real server, plain and with the behaviour broken',
			'Your first migration on chant\'s local emulator, with no cloud account',
		],
		differs: {},
		first: {
			command: { clickhouse: template(clickhouse), postgres: template(postgres) },
			link: { label: 'Your first migration', href: 'getting-started' },
		},
		claims: ['migrations', 'forge'],
		tasks: [
			{ label: 'Your first migration', href: 'getting-started' },
		],
		background: [
			{ label: 'The ClickHouse example', href: 'https://github.com/INTENTIUS/sql-yodeler/tree/main/examples/clickhouse' },
			{ label: 'The Postgres example', href: 'https://github.com/INTENTIUS/sql-yodeler/tree/main/examples/postgres' },
			{ label: 'The two workflows', href: 'workflows' },
		],
		reference: [
			{ label: 'Claims status', href: 'claims' },
			{ label: 'The commands', href: 'cli' },
		],
	},
];

/** A room by id; throws on one that does not exist. */
export function room(id) {
	const r = ROOMS.find((x) => x.id === id);
	if (!r) throw new Error(`docs-site/rooms.mjs: no room ${id}`);
	return r;
}
