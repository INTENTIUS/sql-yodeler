// Runs after `astro build` (npm run build) and fails it when the built site
// has an internal link or anchor that leads nowhere.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base } from './pages.mjs';

const dist = fileURLToPath(new URL('dist/', import.meta.url));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
	const p = join(dir, n);
	return statSync(p).isDirectory() ? walk(p) : [p];
});

const files = walk(dist);
const problems = [];

const ids = new Map();
const idsOf = (file) => {
	if (!ids.has(file)) ids.set(file, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
	return ids.get(file);
};

/** The built file a site path is served from, or undefined. */
const target = (path) => {
	const p = join(dist, decodeURIComponent(path.slice(base.length)));
	if (existsSync(p) && statSync(p).isFile()) return p;
	if (existsSync(join(p, 'index.html'))) return join(p, 'index.html');
	return undefined;
};

for (const f of files.filter((f) => f.endsWith('.html'))) {
	const html = readFileSync(f, 'utf8');
	for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		const href = raw.replace(/&amp;/g, '&');
		if (/^(https?:|mailto:|data:|\/\/)/.test(href)) continue;
		const [path, anchor] = href.split('#');
		let file = f;
		if (path) {
			if (!path.startsWith(`${base}/`)) {
				problems.push(`${relative(dist, f)}: ${href} is outside ${base}/`);
				continue;
			}
			file = target(path.split('?')[0]);
			if (!file) {
				problems.push(`${relative(dist, f)}: ${href} leads nowhere`);
				continue;
			}
		}
		if (anchor && file.endsWith('.html') && !idsOf(file).has(decodeURIComponent(anchor))) {
			problems.push(`${relative(dist, f)}: ${href} names an anchor the page does not have`);
		}
	}
}

for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
console.log(`dist: ${files.length} files, every internal link resolves`);
