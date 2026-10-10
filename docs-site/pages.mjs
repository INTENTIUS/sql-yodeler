// The site's pages, written from the repository's Markdown on every build.
//
// docs/*.md is the only source. writePages() turns each file into a Starlight
// page under src/content/docs/ (gitignored, never committed): the first
// heading becomes the title, links between docs pages become site links, and
// links into the rest of the repository (examples, source files) become their
// plain text, because the repository is private. The landing page is the
// README's intro over docs/README.md, and the sidebar follows the order of
// docs/README.md's table, then any page the table does not list.

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** The sidebar: docs/README.md's table order, then any page it does not list. */
export function sidebar() {
	const files = docFiles();
	const slugs = new Set(files.map((f) => f.slug));
	const items = [];
	for (const m of read(new URL('README.md', docsDir)).matchAll(/^\|\s*\[([^\]]+)\]\(([\w-]+)\.md\)/gm)) {
		const slug = m[2].toLowerCase();
		if (slugs.has(slug) && !items.some((i) => i.slug === slug)) items.push({ label: m[1], slug });
	}
	for (const { file, slug } of files) {
		if (!items.some((i) => i.slug === slug)) items.push({ label: splitTitle(read(new URL(file, docsDir)), file).title, slug });
	}
	return items;
}

export function writePages() {
	const files = docFiles();
	const slugs = new Set(files.map((f) => f.slug));
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	for (const { file, slug } of files) {
		const { title, body } = splitTitle(read(new URL(file, docsDir)), file);
		writeFileSync(`${outDir}${slug}.md`, frontmatter({ title }) + rewriteLinks(body, slugs));
	}
	const first = sidebar()[0];
	const index = splitTitle(read(new URL('README.md', docsDir)), 'docs/README.md');
	const head = `---
title: ${JSON.stringify(index.title)}
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
