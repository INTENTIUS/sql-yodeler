// The agent index, built from the docs collection so it never drifts from the
// site. llms.txt lists every page; llms-full.txt carries their text.
import { getCollection } from 'astro:content';
import { pageUrl } from '../markdown';
import { SITE } from '../../prompts.mjs';

export async function pages() {
	const docs = await getCollection('docs');
	// The agents page first, the landing page next, then the sidebar's order.
	const rank = (d: (typeof docs)[number]) => (d.id === 'agents' ? -2 : d.id === 'index' ? -1 : (d.data.rank ?? Number.MAX_SAFE_INTEGER));
	return docs
		.filter((d) => d.id !== '404')
		.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
		.map((d) => ({
			id: d.id,
			title: d.data.title,
			description: d.data.description ?? '',
			url: pageUrl(d.id),
			prompt: d.data.prompt,
			body: d.body ?? '',
		}));
}

export const PREAMBLE = `# SQL Yodeler

> Schema management and migrations for ClickHouse and Postgres. The schema is declared in TypeScript with chant's sql lexicon; the yodel CLI writes versioned migrations from it, lints them, and applies them behind an approval bound to a digest of the plan.

Agents setting SQL Yodeler up in a repository: start with ${SITE}/agents/. A person new to it: ${SITE}/getting-started/.

A page with a prompt carries it under "Optional: hand this page to your coding agent", and this file lists it under the page. Every prompt forbids applying to a shared environment, approving and merging; those stay with people.`;
