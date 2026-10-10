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
	migrations: [
		`\`yodel lint\` reports a fork on this branch. Following ${pageUrl('migrations')} (Forks and yodel rebase), run \`npx yodel rebase\` with \`--env\` for each environment I name, so a migration that ran is never moved, then \`npx yodel lint\`, and push the branch.`,
		neverLine,
	].join('\n'),
};
