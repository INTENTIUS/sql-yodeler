// The prompts handed to a coding agent, one source for the site and the
// checks. pages.mjs writes a page's prompt into its front matter, the page
// header shows it under the title with a Copy button, and llms.txt and
// llms-full.txt carry it. docs/agents.md quotes the setup prompt word for
// word. test/docs.test.ts fails a prompt that lacks the never-line or does not
// name its own page.

export const SITE = 'https://intentius.io/sql-yodeler';

/** In every prompt, word for word. */
export const neverLine =
	'Never run `yodel apply` against a shared environment, never run `chant approve`, `yodel approve` or `yodel override`, never edit the `chant/lifecycle` branch or `.chant/allowed_signers`, never merge; approvals and applies belong to people.';

/** The site address of a docs page, by slug. */
export const pageUrl = (slug) => (slug === 'index' ? `${SITE}/` : `${SITE}/${slug}/`);

export const setupPrompt = [
	'Set up SQL Yodeler in this repository.',
	`Read ${SITE}/llms.txt first, then`,
	`${pageUrl('agents')} and follow it.`,
	'Open a pull request with the result.',
	neverLine,
].join('\n');

/** Each task page's prompt, by the page's slug (its file name in docs/). */
export const pagePrompts = {
	agents: setupPrompt,
	'getting-started': [
		`Follow ${pageUrl('getting-started')} in a new directory: make the project, start the local emulator, and write and plan the first migration.`,
		'Run `npx yodel apply dev` against the emulator, and when it stops at the approval, show me the approve command it printed and stop there.',
		neverLine,
	].join('\n'),
	adoption: [
		`Take the existing database of the environment I name into versioned migrations with SQL Yodeler, following ${pageUrl('adoption')}.`,
		'Make the project from the starter template with the existing database or schema name first, and ask me before running `YODEL_CREDENTIALS=writer npx yodel init --from <env> --force`: it writes one row to that environment\'s history.',
		'Open a pull request with src/, the baseline migration and the config.',
		neverLine,
	].join('\n'),
	'from-other-tools': [
		`Move this repository's database migrations from the tool it uses now to SQL Yodeler, following ${pageUrl('from-other-tools')}.`,
		'Make the project from the starter template, move the old migration files out of migrations/, and ask me before running `YODEL_CREDENTIALS=writer npx yodel init --from <env> --force` against the environment I name: it writes one row to that environment\'s history.',
		'Leave the old tool\'s history table in the database.',
		'Open a pull request with src/, the baseline migration, the config and the pipelines, with the old tool\'s migration jobs removed and listed in its description.',
		neverLine,
	].join('\n'),
	workflows: [
		`Make the schema change I describe with SQL Yodeler, following ${pageUrl('workflows')}: edit the declarations in src/, run \`npx yodel new <name>\` and \`npx yodel lint\`, and open a pull request with src/ and the new migration.`,
		'Do not edit a migration that is committed on the default branch; write a new one.',
		neverLine,
	].join('\n'),
	lint: [
		`Fix the \`yodel lint\` findings on this branch, following ${pageUrl('lint')}.`,
		'Change a migration that is applied nowhere, or write the change another way; add a `-- yodel:allow` line only with a reason I give you, and record the checksum with `npx yodel lint --update-checksum <id>`.',
		neverLine,
	].join('\n'),
	approval: [
		`An apply was refused or is waiting for approval. Following ${pageUrl('approval')}, read the job log and \`npx yodel plan <env>\` with the reader's credentials, and tell me what the plan would run, what moved since the last approval, and the approve command.`,
		neverLine,
	].join('\n'),
	'lint-and-plan': [
		`Set up SQL Yodeler's pull request checks without its apply pipeline, following ${pageUrl('lint-and-plan')}: set \`ci: { apply: false }\` in yodel.config.ts, run \`npm run ci\`, delete the apply files it no longer writes, and check that \`npx yodel ci --check\` passes.`,
		'List the readers\' secrets the forge needs in the pull request description, and add no writer\'s secret.',
		'Open a pull request with the result.',
		neverLine,
	].join('\n'),
	migrations: [
		`\`yodel lint\` reports a fork on this branch. Following ${pageUrl('migrations')} (Forks and yodel rebase), run \`npx yodel rebase\` with \`--env\` for each environment I name, so a migration that ran is never moved, then \`npx yodel lint\`, and push the branch.`,
		neverLine,
	].join('\n'),
	steps: [
		`Write the data change I describe as a step of a migration, following ${pageUrl('steps')}.`,
		'For a backfill, run `npx yodel new <name> --backfill`, fill in `backfills/<name>.json` (the table, the key, the batch size and the SQL of one batch between `{from}` and `{to}`), and run the same command again. For a Postgres column rename, write `-- previously: <old name>` on the new column\'s line in src/ before `npx yodel new <name>`.',
		'Run `npx yodel lint`, and open a pull request with src/, backfills/ and the new migration.',
		neverLine,
	].join('\n'),
	access: [
		`Declare the access I describe in src/, next to the tables it is about, following ${pageUrl('access')}: row-level security, policies, roles and grants on Postgres; users, roles, row policies and grants on ClickHouse. Keep to what the page says the schema owns.`,
		'Set `access: true` in yodel.config.ts for the environments I name, run `npx yodel new <name>` and `npx yodel lint`, and open a pull request with src/, the config and the new migration.',
		neverLine,
	].join('\n'),
	drift: [
		`The drift watch reported drift in the environment I name. Following ${pageUrl('drift')}, run \`npx yodel drift <env>\` with the reader's credentials and tell me what changed out of band.`,
		'Then ask me whether to put the live object back by hand or keep the change. To keep it, declare it in src/, run `npx yodel new <name>` and `npx yodel lint`, and open a pull request.',
		neverLine,
	].join('\n'),
	audit: [
		`Following ${pageUrl('audit')}, fetch the \`chant/lifecycle\` branch and run \`npx yodel report\` with the readers' credentials.`,
		'Tell me which migrations are applied where, who approved each apply, and each gap the report lists, with what the page says it means.',
		neverLine,
	].join('\n'),
	forges: [
		`Prepare this repository's pipelines for the forges I name, following ${pageUrl('forges')}: set \`ci.forges\` in yodel.config.ts, run \`npm run ci\`, and check that \`npx yodel ci --check\` passes.`,
		'In the pull request description, list by name every secret, variable, environment, protection, token and runner the matrix says each forge needs. Put no secret\'s value in a file or in the description; I add them.',
		'Open a pull request with the result.',
		neverLine,
	].join('\n'),
	orm: [
		`Bring the tables our ORM defines into SQL Yodeler, following ${pageUrl('orm')}: add a source under \`sources\` in yodel.config.ts with the command that prints the ORM's DDL, and remove any declaration in src/ of a table the ORM now owns.`,
		'Run `npx yodel new <name>` and `npx yodel lint`, and open a pull request with the config, src/ and the new migration.',
		neverLine,
	].join('\n'),
	notify: [
		`Turn on SQL Yodeler's webhook events, following ${pageUrl('notify')}: add \`notify\` to yodel.config.ts with the names of the variables that hold the webhook's URL and the signing key, never the URL or the key themselves.`,
		'Write a receiver\'s check of the signature as the page shows, in the language I name, and list the variables the pipelines need in the pull request description.',
		'Open a pull request with the result.',
		neverLine,
	].join('\n'),
	'schema-docs': [
		`Following ${pageUrl('schema-docs')}, run \`npx yodel docs\` and open a pull request with schema-docs/.`,
		'In its description, name the tables and relations the diagram shows that the pull request changes.',
		neverLine,
	].join('\n'),
};
