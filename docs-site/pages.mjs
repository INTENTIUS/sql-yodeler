// The site's pages, written from the repository's Markdown on every build.
//
// docs/*.md is the source, with rooms.mjs for the room pages under for/ (the
// Rooms section below). writePages() turns each docs file into a Starlight
// page under src/content/docs/ (gitignored, never committed): the first
// heading becomes the title, links between docs pages become site links, and
// links into the rest of the repository (examples, source files) become their
// plain text. Each page's editUrl points "Edit page" at its docs/ file (none
// for claims.md, which npm run claims:page writes). The landing page is
// src/components/Landing.astro, then the starting-point picker
// (src/components/Picker.astro), then docs/README.md. The sidebar opens with "Start here", the
// rooms, then groups the pages by the `type:` in their front matter
// (Tutorial, How-to, Concepts, Reference, Proof), each group in the order of
// docs/README.md's table, and the build fails on a page with no type or an
// unknown one. The 404 page is written here too, with the hat.
//
// Tabs: a block between `<!-- tabs: <key> -->` and `<!-- /tabs -->` whose
// sections start at `####` headings is one Starlight tab group on the site
// (tabsToMdx() has the rules), and plain sections on GitHub. A page with one
// is written as `<slug>.mdx`, and its Markdown, tab sections under their
// `####` headings, is kept in its front matter as `markdown`: llms-full.txt and
// "Copy page as Markdown" use that in place of the MDX body
// (src/content.config.ts, src/pages/_llms.ts, src/components/PageTitle.astro).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pagePrompts } from './prompts.mjs';
import { DIALECTS, FORGES, ROLES, ROOMS, STARTS } from './rooms.mjs';

export const base = '/sql-yodeler';

/** Where "Edit page" opens a docs file on GitHub. */
const editBase = 'https://github.com/INTENTIUS/sql-yodeler/edit/main/docs/';

/** Pages generated from something else, with no file to edit by hand. */
const generated = new Set(['claims']);

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
				// An example's schema reference (yodel docs) is published next to the pages.
				const schema = /^\.\.\/examples\/([\w-]+)\/schema-docs\/index\.html$/.exec(target);
				if (schema) return `[${text}](${base}/examples/${schema[1]}/schema/)`;
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

/** The tab groups a docs page may use, `<!-- tabs: <key> -->`, and the labels each allows. */
export const tabKeys = { dialect: ['ClickHouse', 'Postgres'], forge: ['GitHub', 'GitLab', 'Forgejo'] };

const TABS_OPEN = /^<!--\s*tabs:\s*(\S*)\s*-->\s*$/;
const TABS_CLOSE = /^<!--\s*\/tabs\s*-->\s*$/;

/**
 * One line of Markdown outside fences, made valid MDX: HTML comments dropped
 * (`state.comment` carries one across lines), `{`, `}` and `<` escaped, code
 * spans and backslash escapes kept as they are.
 */
function mdxLine(line, state) {
	let out = '';
	let i = 0;
	while (i < line.length) {
		if (state.comment) {
			const end = line.indexOf('-->', i);
			if (end === -1) return out;
			state.comment = false;
			i = end + 3;
			continue;
		}
		const c = line[i];
		if (c === '\\') {
			out += line.slice(i, i + 2);
			i += 2;
		} else if (c === '`') {
			const run = /^`+/.exec(line.slice(i))[0];
			const close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
			close.lastIndex = i + run.length;
			const m = close.exec(line);
			const end = m ? m.index + run.length : i + run.length;
			out += line.slice(i, end);
			i = end;
		} else if (line.startsWith('<!--', i)) {
			state.comment = true;
			i += 4;
		} else {
			out += c === '{' || c === '}' || c === '<' ? `\\${c}` : c;
			i += 1;
		}
	}
	return out;
}

/**
 * A docs page's tabs blocks as Starlight tab groups:
 *
 *     <!-- tabs: dialect -->
 *     #### ClickHouse
 *     ...
 *     #### Postgres
 *     ...
 *     <!-- /tabs -->
 *
 * becomes <Tabs syncKey="dialect"> with a <TabItem label="..."> per `####`
 * heading. On GitHub the reader sees each section under its heading. Lines in
 * code fences are left alone. `count` is the number of blocks; when it is 0
 * the page stays Markdown and `mdx` is not used. Otherwise `mdx` is the whole
 * text as MDX: the rest of the page has its HTML comments dropped and `{`, `}`
 * and `<` escaped outside code (so raw HTML does not survive on such a page).
 * A malformed block throws, `where(i)` naming the docs file and line i
 * (0-based) of `md`.
 */
export function tabsToMdx(md, where) {
	const out = [];
	const state = { comment: false };
	let fence = null;
	let block = null;
	let count = 0;
	const closeItem = () => {
		if (block?.item) out.push('', '</TabItem>', '');
		if (block) block.item = null;
	};
	md.split('\n').forEach((line, i) => {
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fence) fence = f[1];
			else if (f[1].startsWith(fence)) fence = null;
		}
		if (fence || f) {
			if (block && !block.item) throw new Error(`${where(i)}: text before the first #### heading in the tabs block opened at line ${block.line}`);
			out.push(line);
			return;
		}
		if (!state.comment) {
			const open = TABS_OPEN.exec(line);
			if (open) {
				if (block) throw new Error(`${where(i)}: a tabs block inside the one opened at line ${block.line}; close it with <!-- /tabs --> first`);
				if (!tabKeys[open[1]]) throw new Error(`${where(i)}: tabs: ${open[1] || '(none)'} is not a tab group; use one of ${Object.keys(tabKeys).join(', ')}`);
				block = { key: open[1], line: i + 1, item: null, labels: [] };
				count += 1;
				out.push('', `<Tabs syncKey="${block.key}">`, '');
				return;
			}
			if (TABS_CLOSE.test(line)) {
				if (!block) throw new Error(`${where(i)}: <!-- /tabs --> with no tabs block open`);
				if (!block.labels.length) throw new Error(`${where(i)}: the tabs block opened at line ${block.line} has no #### headings`);
				closeItem();
				out.push('</Tabs>', '');
				block = null;
				return;
			}
			const h = block && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
			if (h) {
				if (h[1].length !== 4) throw new Error(`${where(i)}: a ${h[1]} heading inside the tabs block opened at line ${block.line}; each tab starts at a #### heading, and nothing else in the block may be a heading`);
				const label = h[2];
				if (!tabKeys[block.key].includes(label)) throw new Error(`${where(i)}: #### ${label} is not a tab of ${block.key}; use one of ${tabKeys[block.key].join(', ')}`);
				closeItem();
				block.item = label;
				block.labels.push(label);
				out.push(`<TabItem label="${label}">`, '');
				return;
			}
			if (block && !block.item && line.trim() !== '') throw new Error(`${where(i)}: text before the first #### heading in the tabs block opened at line ${block.line}`);
		}
		out.push(mdxLine(line, state));
	});
	if (block) throw new Error(`${where(block.line - 1)}: the tabs block opened here has no <!-- /tabs --> to close it`);
	return { count, mdx: out.join('\n').replace(/\n{3,}/g, '\n\n') };
}

/** The import an MDX page with tabs needs, after its front matter. */
const mdxImport = "import { Tabs, TabItem } from '@astrojs/starlight/components';\n\n";

/**
 * A page's file under src/content/docs/: `<slug>.md` as it is, or, when the
 * Markdown has tabs blocks, `<slug>.mdx` with the import and the tab groups,
 * and the Markdown kept in the front matter as `markdown` for llms-full.txt
 * and "Copy page as Markdown". `md` is checked by line against `source`, the
 * text it came from, which `where` names in errors (`docs/<file>`).
 */
function writePage(slug, head, md, source, where) {
	tabsToMdx(source, (i) => `${where}:${i + 1}`);
	const { count, mdx } = tabsToMdx(md, () => where);
	if (!count) {
		writeFileSync(`${outDir}${slug}.md`, head + md);
		return;
	}
	const front = head.replace(/\n---\n\n$/, `\nmarkdown: ${JSON.stringify(md)}\n---\n\n`);
	writeFileSync(`${outDir}${slug}.mdx`, front + mdxImport + mdx);
}

/**
 * A docs page's own front matter: the claims that prove it, whether it is a
 * draft (scenarios/docs-claims.ts has the rules; npm run check enforces them),
 * and its type, which puts it in a sidebar group.
 */
export function pageFront(md) {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
	const lines = m ? m[1].split('\n') : [];
	const value = (key) => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
	const inner = /^\[(.*)\]$/.exec(value('claims') ?? '[]')?.[1] ?? '';
	return { claims: inner.split(',').map((c) => c.trim()).filter(Boolean), draft: value('draft') === 'true', type: value('type') };
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

/** A table of claims with each one's verdicts per dialect and its last run, from the record's rows. */
function claimsTable(names, rows) {
	const lines = names.map((name) => {
		const rs = rows.get(name) ?? [];
		const says = (rs[0]?.says ?? '').replace(/\|/g, '\\|');
		const verdicts = rs.length ? rs.map((r) => `${dialectName[r.dialect] ?? r.dialect}: ${r.plain}, ${r.break}`).join('; ') : 'not recorded';
		const last = rs.length ? rs.map((r) => `\`${r.commit ?? 'unknown'}\`, ${r.recorded.slice(0, 10)}`).filter((v, i, a) => a.indexOf(v) === i).join('; ') : '';
		return `| \`${name}\` | ${says} | ${verdicts} | ${last} |`;
	});
	return `| Claim | What it says | Plain, broken | Last run |\n|---|---|---|---|\n${lines.join('\n')}\n`;
}

/** The product-scenario rows claims cite (scenarios/product-proofs.json) and the version the claims are about (package.json's). */
function productProofs() {
	const file = new URL('scenarios/product-proofs.json', repo);
	const proofs = existsSync(file) ? JSON.parse(read(file)).proofs : [];
	return { proofs, version: JSON.parse(read(new URL('package.json', repo))).version };
}

/**
 * The product-scenario rows that cite one of `names`, as a table with a link
 * to each row and whether it counts (its engine version is `version`); empty
 * when none cites them. scenarios/product-proofs.ts has the rules.
 */
export function productRowsMarkdown(names, { proofs, version }) {
	const rows = proofs.filter((p) => names.includes(p.claim));
	if (!rows.length) return '';
	const lines = rows.map((p) => `| \`${p.claim}\` | ${p.repo} | [${p.scenario}](https://github.com/${p.repo}/commit/${p.commit}) | \`${p.commit}\`, ${p.date} | ${p.engine_version} | ${p.engine_version === version ? 'yes' : `no, the claims are about ${version}`} |`);
	return `\n\nProduct scenario rows cited by these claims count only at the version the claims are about. They add to the claims' own runs and never replace them.\n\n| Claim | Repo | Scenario | Commit, date | Engine version | Counts |\n|---|---|---|---|---|---|\n${lines.join('\n')}\n`;
}

/** "Proven by" at the end of a page, and on a draft a note at the top naming what is not proven yet. */
function claimsSections(front, rows, proofs = productProofs()) {
	if (!front.claims.length) return { top: '', bottom: '' };
	const bottom = `\n\n## Proven by\n\nThe scenario claims below run what this page describes against a real server, once plain (it passes) and once with the behaviour broken (the claim catches it). [Claims status](claims.md) lists every claim.\n\n${claimsTable(front.claims, rows)}${productRowsMarkdown(front.claims, proofs)}`;
	const pending = front.claims.filter((name) => !(rows.get(name) ?? []).length || !(rows.get(name) ?? []).every(holds));
	const top = front.draft && pending.length
		? `:::caution[Not proven yet]\nThis page is a draft: ${pending.map((c) => `\`${c}\``).join(', ')} ${pending.length === 1 ? 'does' : 'do'} not pass plain and get caught broken in the claims record yet (pending or not recorded), so what it describes may not hold. It is left out of llms.txt until ${pending.length === 1 ? 'it does' : 'they do'}.\n:::\n\n`
		: '';
	return { top, bottom };
}

/** The hat, `h` CSS pixels tall (brand/hat.png is drawn at 336, twice the largest size shown; components/Hat.astro does the same). */
const hatImg = (h) => `<img class="sy-hero-hat" src="${base}/brand/hat.png" width="${Math.round((h * 728) / 672)}" height="${h}" alt="">`;

/** The 404 page: the hat, the news, and the way back. */
const notFound = `---
title: "Page not found"
description: "This address has no page on the SQL Yodeler site."
template: splash
editUrl: false
pagefind: false
hero:
  title: "Page not found"
  tagline: ${JSON.stringify(`This address has no page. Start again from <a href="${base}/">the home page</a>, or find the page in <a href="${base}/llms.txt">llms.txt</a>, which lists every page.`)}
  image:
    html: ${JSON.stringify(hatImg(144))}
---
`;

const frontmatter = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n`;

/** Each page's one-line description, from the second column of docs/README.md's table, by slug. */
export function descriptions() {
	const out = {};
	for (const m of read(new URL('README.md', docsDir)).matchAll(/^\|\s*\[[^\]]+\]\(([\w-]+)\.md\)\s*\|\s*(.+?)\s*\|\s*$/gm)) {
		out[m[1].toLowerCase()] = m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	}
	return out;
}

/** The sidebar groups, in order, by the `type:` a page's front matter gives. */
const groups = [
	['tutorial', 'Tutorial'],
	['howto', 'How-to'],
	['concepts', 'Concepts'],
	['reference', 'Reference'],
	['proof', 'Proof'],
];

/** Each page's type, by slug; throws naming the file when a page has none or one not in `groups`. */
function pageTypes() {
	const out = {};
	for (const { file, slug } of docFiles()) {
		const { type } = pageFront(read(new URL(file, docsDir)));
		if (!groups.some(([t]) => t === type)) {
			throw new Error(`docs/${file}: ${type ? `type: ${type} is not one of` : 'no type: in its front matter; give it one of'} ${groups.map(([t]) => t).join(', ')}`);
		}
		out[slug] = type;
	}
	return out;
}

/** The rooms, starts first and then roles, as sidebar items. */
const roomItems = () => [...STARTS, ...ROLES].map((x) => ({ label: x.label, slug: `for/${x.room}` }));

/** The pages the site leads with: the declared schema, which everything else works from, and the data changes a migration carries. */
const lead = [
	{ label: 'Declaring the schema', slug: 'schema' },
	{ label: 'Data migrations', slug: 'steps' },
];

/**
 * The sidebar: "Start here" with the rooms, the declared schema and data
 * migrations on their own, then one group per page type, in the order of `groups`. Every group starts
 * collapsed; Starlight opens the one that holds the current page.
 */
export function sidebar() {
	return [{ label: 'Start here', collapsed: true, items: roomItems() }, ...lead, ...docGroups()];
}

/**
 * The docs pages' groups, one per page type. Within a group, pages follow
 * docs/README.md's table, then any page it does not list.
 */
function docGroups() {
	const files = docFiles();
	const types = pageTypes();
	const items = [];
	for (const m of read(new URL('README.md', docsDir)).matchAll(/^\|\s*\[([^\]]+)\]\(([\w-]+)\.md\)/gm)) {
		const slug = m[2].toLowerCase();
		if (slug in types && !items.some((i) => i.slug === slug)) items.push({ label: m[1], slug });
	}
	for (const { file, slug } of files) {
		if (!items.some((i) => i.slug === slug)) items.push({ label: splitTitle(read(new URL(file, docsDir)), file).title, slug });
	}
	return groups
		.map(([type, label]) => ({ label, collapsed: true, items: items.filter((i) => types[i.slug] === type && !lead.some((l) => l.slug === i.slug)) }))
		.filter((g) => g.items.length);
}

// ── Rooms ────────────────────────────────────────────────────────────────────
//
// One page per starting point and role, from docs-site/rooms.mjs: the page is
// src/components/Room.astro (the lede, cards for Works, Differs and First
// step, then Proof and Then read), and roomMarkdown() is the same content as
// Markdown, kept in the front matter for llms-full.txt and "Copy page as
// Markdown". The sections are the same on every room, in this order.

const roomsFile = 'docs-site/rooms.mjs';
const roomsEditUrl = 'https://github.com/INTENTIUS/sql-yodeler/edit/main/docs-site/rooms.mjs';

/** A heading's anchor as the site gives it: smart dashes, then GitHub's slug, numbered when it repeats. */
function anchorOf(text, seen) {
	const plain = text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/`/g, '')
		.replace(/---/g, '—')
		.replace(/--/g, '–');
	const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
	let slug = base;
	for (let n = 1; seen.has(slug); n += 1) slug = `${base}-${n}`;
	seen.add(slug);
	return slug;
}

/** The anchors of a docs page's headings, outside code fences and tabs blocks, with "Proven by" when the page has claims. */
function anchors(md) {
	const seen = new Set();
	let fence = null;
	let tabs = false;
	for (const line of md.split('\n')) {
		const f = /^\s*(`{3,}|~{3,})/.exec(line);
		if (f) {
			if (!fence) fence = f[1];
			else if (f[1].startsWith(fence)) fence = null;
			continue;
		}
		if (fence) continue;
		if (TABS_OPEN.test(line)) tabs = true;
		else if (TABS_CLOSE.test(line)) tabs = false;
		const h = !tabs && /^#{2,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) anchorOf(h[1], seen);
	}
	if (pageFront(md).claims.length) anchorOf('Proven by', seen);
	return seen;
}

/**
 * Throws, naming the room, when one of its links leads to no docs page or no
 * heading on it, or one of its claims is not in the record.
 */
export function checkRoom(r, slugs, rows) {
	const links = [r.first.link, ...r.tasks, ...r.background, ...r.reference];
	for (const { label, href } of links) {
		if (/^https:\/\//.test(href)) continue;
		const [slug, anchor] = href.split('#');
		if (!slugs.has(slug)) throw new Error(`${roomsFile}: room ${r.id} links "${label}" to ${href}, but docs/ has no page ${slug}.md`);
		if (anchor && !anchors(read(new URL(`${slug}.md`, docsDir))).has(anchor)) {
			throw new Error(`${roomsFile}: room ${r.id} links "${label}" to ${href}, but docs/${slug}.md has no heading with the anchor #${anchor}`);
		}
	}
	for (const name of r.claims) {
		if (!rows.has(name)) throw new Error(`${roomsFile}: room ${r.id} names the claim ${name}, which scenarios/claims-record.json does not have`);
	}
	for (const id of Object.keys(r.differs)) {
		if (![...DIALECTS, ...FORGES].some((x) => x.id === id)) throw new Error(`${roomsFile}: room ${r.id} has differs for ${id}, which is not a dialect or forge`);
	}
}

/** A room's link as Markdown: a docs slug becomes a link to its .md file, which rewriteLinks() turns into a site link. */
const roomLink = ({ label, href }) => {
	if (/^https:\/\//.test(href)) return `[${label}](${href})`;
	const [slug, anchor] = href.split('#');
	return `[${label}](${slug}.md${anchor ? `#${anchor}` : ''})`;
};

/** A tabs block of `key` with one section per item, or nothing when every section is empty. */
function tabsBlock(key, items) {
	if (items.every((x) => !x.body)) return '';
	return [`<!-- tabs: ${key} -->`, ...items.flatMap((x) => [`#### ${x.label}`, '', x.body || 'Nothing beyond the other pages.', '']), '<!-- /tabs -->', ''].join('\n');
}

const bullets = (lines) => lines.map((l) => `- ${l}`).join('\n');
const fenced = (lang, text) => `\`\`\`${lang}\n${text}\n\`\`\``;

/** A room's page as Markdown, its tab groups as tabs blocks. */
export function roomMarkdown(r, rows) {
	const out = [r.lede, '', '## Works', '', bullets(r.works), ''];
	out.push('## Differs', '');
	out.push('### By database', '', tabsBlock('dialect', DIALECTS.map((d) => ({ label: d.label, body: bullets([...d.differs, ...(r.differs[d.id] ?? [])]) }))));
	out.push('### By forge', '', tabsBlock('forge', FORGES.map((f) => ({ label: f.label, body: bullets([...f.differs, ...(r.differs[f.id] ?? [])]) }))));
	out.push('## First step', '');
	if (r.first.note) out.push(r.first.note, '');
	const lang = r.first.lang ?? 'sh';
	const cmd = r.first.command ?? {};
	if (cmd.any) out.push(fenced(lang, cmd.any), '');
	else if (cmd.clickhouse && cmd.postgres && cmd.clickhouse !== cmd.postgres) {
		out.push(tabsBlock('dialect', DIALECTS.map((d) => ({ label: d.label, body: fenced(lang, cmd[d.id]) }))));
	} else if (cmd.clickhouse || cmd.postgres) out.push(fenced(lang, cmd.clickhouse ?? cmd.postgres), '');
	out.push(`Next: ${roomLink(r.first.link)}.`, '');
	out.push('## Proof', '');
	if (r.claims.length) {
		out.push('The scenario claims below run what this room relies on against a real server, once plain (it passes) and once with the behaviour broken (the claim catches it). [Claims status](claims.md) lists every claim.', '', claimsTable(r.claims, rows));
	} else {
		out.push('No scenario claim runs what this room describes. [Claims status](claims.md) lists every claim.', '');
	}
	out.push('## Then read', '');
	for (const [label, links] of [['Tasks', r.tasks], ['Background', r.background], ['Reference', r.reference]]) {
		if (links.length) out.push(`### ${label}`, '', bullets(links.map(roomLink)), '');
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * The home page, index.mdx: the landing (src/components/Landing.astro: the
 * hat, the wordmark, the declared schema, the picker and the highlights), the
 * pipelines and the waves, then docs/README.md's text made valid MDX, then the setup prompt.
 * The Markdown is kept in the front matter for llms-full.txt, as on a page
 * with tabs.
 */
function writeHome(head, md, source) {
	tabsToMdx(source, (i) => `docs/README.md:${i + 1}`);
	const { mdx } = tabsToMdx(md, () => 'docs/README.md');
	const front = head.replace(/\n---\n\n$/, `\nmarkdown: ${JSON.stringify(md)}\n---\n\n`);
	const body = `import Landing from '../../components/Landing.astro';
import Pipelines from '../../components/Pipelines.astro';
import Waves from '../../components/Waves.astro';

<Landing />

## The pipelines yodel ci writes

\`npm run ci\` renders them for GitHub Actions, GitLab CI and Forgejo Actions, from the environments and the Ops the project declares. [The two workflows](${base}/workflows/#the-pipelines-yodel-ci).

<Pipelines />

## A gate per environment

Each environment is one wave of the apply pipeline, applied after the wave before it. Its gate policy decides when it waits for a person, and an approval covers exactly the plan it was shown, by its digest.

<Waves />

[Approval](${base}/approval/) has the policies, the digest and what happens when it moves.

## The docs

${mdx}

## Hand the setup to your agent

[Your first migration](${base}/getting-started/) has the same steps by hand. Or paste this into a coding agent in your repository. [The agent page](${base}/agents/) says what the agent does; it never applies and never approves.

<Landing part="agent" />
`;
	writeFileSync(`${outDir}index.mdx`, `${front}${mdxImport}${body}`);
}

/** Writes every room under for/, after checking its links and claims. */
function writeRooms(slugs, rows, order) {
	const ids = [...STARTS, ...ROLES].map((x) => x.room);
	for (const id of ids) if (!ROOMS.some((r) => r.id === id)) throw new Error(`${roomsFile}: ${id} is a start or role with no room in ROOMS`);
	mkdirSync(`${outDir}for`, { recursive: true });
	for (const r of ROOMS) {
		checkRoom(r, slugs, rows);
		const slug = `for/${r.id}`;
		const md = roomMarkdown(r, rows);
		// The tabs blocks are checked as on any page; the page itself is the Room
		// component, with the Markdown in the front matter for llms-full.txt.
		tabsToMdx(md, () => `${roomsFile} (room ${r.id})`);
		const fields = { title: r.title, description: r.lede, rank: order.indexOf(slug), claims: r.claims, editUrl: roomsEditUrl, tableOfContents: false, markdown: rewriteLinks(md, slugs) };
		writeFileSync(`${outDir}${slug}.mdx`, `${frontmatter(fields)}import Room from '../../../components/Room.astro';\n\n<Room id=${JSON.stringify(r.id)} />\n`);
	}
}

export function writePages() {
	const files = docFiles();
	const slugs = new Set(files.map((f) => f.slug));
	// The sidebar's order, which also fails the build on a page without a type.
	const order = sidebar().flatMap((g) => (g.items ? g.items.map((i) => i.slug) : [g.slug]));
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const described = descriptions();
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
			editUrl: generated.has(slug) ? false : `${editBase}${file}`,
		};
		writePage(slug, frontmatter(fields), rewriteLinks(top + body.trimEnd() + bottom, slugs), text, `docs/${file}`);
	}
	writeRooms(slugs, rows, order);
	const index = splitTitle(read(new URL('README.md', docsDir)), 'docs/README.md');
	const head = `---
title: ${JSON.stringify(index.title)}
head:
  - tag: title
    content: ${JSON.stringify(`${index.title}: schema changes for ClickHouse and Postgres, and the ops they imply`)}
description: "Schema changes for ClickHouse and Postgres, and the ops they imply"
editUrl: ${JSON.stringify(`${editBase}README.md`)}
template: splash
---

`;
	writeHome(head, rewriteLinks(index.body, slugs), read(new URL('README.md', docsDir)));
	writeFileSync(`${outDir}404.md`, notFound);
	writeSchemaReferences();
}

/**
 * Each example's schema reference, examples/<name>/schema-docs/index.html
 * (written by yodel docs and committed), copied into public/ so the site
 * serves it at examples/<name>/schema/. public/examples/ is gitignored.
 */
function writeSchemaReferences() {
	const dir = fileURLToPath(new URL('public/examples/', import.meta.url));
	rmSync(dir, { recursive: true, force: true });
	for (const name of readdirSync(new URL('examples/', repo))) {
		const source = new URL(`examples/${name}/schema-docs/index.html`, repo);
		if (!existsSync(source)) continue;
		mkdirSync(`${dir}${name}/schema`, { recursive: true });
		copyFileSync(source, `${dir}${name}/schema/index.html`);
	}
}
