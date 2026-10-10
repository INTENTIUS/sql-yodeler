// The site's pages, written from the repository's Markdown on every build.
//
// docs/*.md is the only source. writePages() turns each file into a Starlight
// page under src/content/docs/ (gitignored, never committed): the first
// heading becomes the title, links between docs pages become site links, and
// links into the rest of the repository (examples, source files) become their
// plain text. The landing page is the
// README's intro over docs/README.md, and the sidebar follows the order of
// docs/README.md's table, then any page the table does not list.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pagePrompts } from './prompts.mjs';

export const base = '/sql-yodeler';

const repo = new URL('../', import.meta.url);
const docsDir = new URL('docs/', repo);
const outDir = fileURLToPath(new URL('src/content/docs/', import.meta.url));

const read = (url) => readFileSync(url, 'utf8');

/** The docs pages by slug (the file name, lower case, without .md), README.md aside. */
function docFiles() {
	return readdirSync(docsDir)
		.filter((f) => f.endsWith('.md') && f !== 'README.md')
		.sort()
		.map((file) => ({ file, slug: file.slice(0, -3).toLowerCase() }));
}

/** The first `# ` heading and the text after it. */
function splitTitle(md, file) {
	const m = /^# (.+)\n+/m.exec(md);
	if (!m) throw new Error(`docs/${file}: no first heading to take the title from`);
	return { title: m[1].trim(), body: md.slice(m.index + m[0].length) };
}

/** Rewrites the links outside code fences: docs pages to site pages, the rest of the repository to plain text. */
function rewriteLinks(md, slugs) {
	let fence = null;
	return md
		.split('\n')
		.map((line) => {
			const f = /^\s*(`{3,}|~{3,})/.exec(line);
			if (f) {
				if (!fence) fence = f[1];
				else if (f[1].startsWith(fence)) fence = null;
				return line;
			}
			if (fence) return line;
			return line.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (all, text, target) => {
				if (/^(https?:|mailto:|#)/.test(target)) return all;
				const m = /^(?:\.\/)?([\w-]+)\.md(#.*)?$/.exec(target);
				if (m) {
					const slug = m[1].toLowerCase();
					if (slug === 'readme') return `[${text}](${base}/${m[2] ?? ''})`;
					if (slugs.has(slug)) return `[${text}](${base}/${slug}/${m[2] ?? ''})`;
				}
				// A repository path keeps its code style once it is no longer a link.
				return /^[\w.-]+\/[\w./-]*$/.test(text) ? `\`${text}\`` : text;
			});
		})
		.join('\n');
}

/**
 * A docs page's own front matter: the claims that prove it and whether it is
 * a draft (scenarios/docs-claims.ts has the rules; npm run check enforces them).
 */
export function pageFront(md) {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
	const lines = m ? m[1].split('\n') : [];
	const value = (key) => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
	const inner = /^\[(.*)\]$/.exec(value('claims') ?? '[]')?.[1] ?? '';
	return { claims: inner.split(',').map((c) => c.trim()).filter(Boolean), draft: value('draft') === 'true' };
}

const dialectName = { ch: 'ClickHouse', pg: 'Postgres' };
const holds = (r) => r.plain === 'pass' && r.break === 'caught';

/** The record's rows for each claim, from scenarios/claims-record.json. */
function recordRows() {
	const record = JSON.parse(read(new URL('scenarios/claims-record.json', repo)));
	const out = new Map();
	for (const r of record.rows) out.set(r.claim, [...(out.get(r.claim) ?? []), r]);
	return out;
}

/** "Proven by" at the end of a page, and on a draft a note at the top naming what is not proven yet. */
function claimsSections(front, rows) {
	if (!front.claims.length) return { top: '', bottom: '' };
	const lines = front.claims.map((name) => {
		const rs = rows.get(name) ?? [];
		const says = (rs[0]?.says ?? '').replace(/\|/g, '\\|');
		const verdicts = rs.length ? rs.map((r) => `${dialectName[r.dialect] ?? r.dialect}: ${r.plain}, ${r.break}`).join('; ') : 'not recorded';
		const last = rs.length ? rs.map((r) => `\`${r.commit ?? 'unknown'}\`, ${r.recorded.slice(0, 10)}`).filter((v, i, a) => a.indexOf(v) === i).join('; ') : '';
		return `| \`${name}\` | ${says} | ${verdicts} | ${last} |`;
	});
	const bottom = `\n\n## Proven by\n\nThe scenario claims below run what this page describes against a real server, once plain (it passes) and once with the behaviour broken (the claim catches it). [Claims status](claims.md) lists every claim.\n\n| Claim | What it says | Plain, broken | Last run |\n|---|---|---|---|\n${lines.join('\n')}\n`;
	const pending = front.claims.filter((name) => !(rows.get(name) ?? []).length || !(rows.get(name) ?? []).every(holds));
	const top = front.draft && pending.length
		? `:::caution[Not proven yet]\nThis page is a draft: ${pending.map((c) => `\`${c}\``).join(', ')} ${pending.length === 1 ? 'does' : 'do'} not pass plain and get caught broken in the claims record yet (pending or not recorded), so what it describes may not hold. It is left out of llms.txt until ${pending.length === 1 ? 'it does' : 'they do'}.\n:::\n\n`
		: '';
	return { top, bottom };
}

const frontmatter = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n`;

/** The README's first paragraph, without the sentences that point into the repository's design and research notes. */
function tagline() {
	const { body } = splitTitle(read(new URL('README.md', repo)), 'README.md');
	const para = body.split(/\n\s*\n/)[0].replace(/\n/g, ' ');
	return para
		.split(/(?<=\.)\s+/)
		.filter((s) => !/\b(design|research)\//.test(s))
		.join(' ')
		.replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Each page's one-line description, from the second column of docs/README.md's table, by slug. */
export function descriptions() {
	const out = {};
	for (const m of read(new URL('README.md', docsDir)).matchAll(/^\|\s*\[[^\]]+\]\(([\w-]+)\.md\)\s*\|\s*(.+?)\s*\|\s*$/gm)) {
		out[m[1].toLowerCase()] = m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	}
	return out;
}

/** The sidebar: docs/README.md's table order, then the pages it does not list, under "For contributors". */
export function sidebar() {
	const files = docFiles();
	const slugs = new Set(files.map((f) => f.slug));
	const items = [];
	for (const m of read(new URL('README.md', docsDir)).matchAll(/^\|\s*\[([^\]]+)\]\(([\w-]+)\.md\)/gm)) {
		const slug = m[2].toLowerCase();
		if (slugs.has(slug) && !items.some((i) => i.slug === slug)) items.push({ label: m[1], slug });
	}
	const rest = files
		.filter(({ slug }) => !items.some((i) => i.slug === slug))
		.map(({ file, slug }) => ({ label: splitTitle(read(new URL(file, docsDir)), file).title, slug }));
	return rest.length ? [...items, { label: 'For contributors', items: rest }] : items;
}

export function writePages() {
	const files = docFiles();
	const slugs = new Set(files.map((f) => f.slug));
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const described = descriptions();
	const order = sidebar().flatMap((i) => (i.items ? i.items.map((j) => j.slug) : [i.slug]));
	const rows = recordRows();
	for (const { file, slug } of files) {
		const text = read(new URL(file, docsDir));
		const { title, body } = splitTitle(text, file);
		const front = pageFront(text);
		const { top, bottom } = claimsSections(front, rows);
		const fields = {
			title,
			...(described[slug] ? { description: described[slug] } : {}),
			...(pagePrompts[slug] ? { prompt: pagePrompts[slug] } : {}),
			rank: order.indexOf(slug),
			claims: front.claims,
			...(front.draft ? { unproven: true } : {}),
		};
		writeFileSync(`${outDir}${slug}.md`, frontmatter(fields) + rewriteLinks(top + body.trimEnd() + bottom, slugs));
	}
	const first = sidebar()[0];
	const index = splitTitle(read(new URL('README.md', docsDir)), 'docs/README.md');
	const head = `---
title: ${JSON.stringify(index.title)}
head:
  - tag: title
    content: ${JSON.stringify(`${index.title}: schema management and migrations for ClickHouse and Postgres`)}
description: "What SQL Yodeler is, the docs pages, and the yodel commands with their exit codes"
template: splash
hero:
  tagline: ${JSON.stringify(tagline())}
  actions:
    - text: ${JSON.stringify(first.label)}
      link: ${JSON.stringify(`${base}/${first.slug}/`)}
      icon: right-arrow
    - text: "@intentius/sql-yodeler on npm"
      link: "https://www.npmjs.com/package/@intentius/sql-yodeler"
      variant: minimal
      icon: external
---

`;
	writeFileSync(`${outDir}index.md`, head + rewriteLinks(index.body, slugs));
}
