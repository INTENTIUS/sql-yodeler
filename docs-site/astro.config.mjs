// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { base, sidebar, writePages } from './pages.mjs';

// The pages come from ../docs; pages.mjs writes them into src/content/docs
// each time the config loads (astro build, astro dev).
writePages();

// Published under the org domain at /sql-yodeler, the same shape terragucci,
// fountain-ops and loomster use. `base` has to match or every internal link
// 404s on Pages.
export default defineConfig({
	site: 'https://intentius.io',
	base,
	integrations: [
		starlight({
			title: 'SQL Yodeler',
			description: 'Schema management and migrations for ClickHouse and Postgres, on chant\'s sql lexicon.',
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/INTENTIUS/sql-yodeler' },
				{ icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/package/@intentius/sql-yodeler' },
			],
			// The pages are generated from docs/, so each page's front matter names its
			// source file as editUrl (pages.mjs); this base is the fallback.
			editLink: { baseUrl: 'https://github.com/INTENTIUS/sql-yodeler/edit/main/' },
			sidebar: sidebar(),
			// The hat (scripts/brand.py draws it): the logo beside the title, the
			// favicons, and the square 400 px hat a shared link shows.
			logo: { src: './src/assets/brand/hat.png', alt: '' },
			favicon: '/favicon.svg',
			customCss: ['./src/styles/sql-yodeler.css'],
			// The title gets a "Copy page as Markdown" button, an llms.txt pointer
			// and, on a task page, its prompt for a coding agent. The footer adds the
			// hat, the header a Docs link, and the theme starts dark.
			components: {
				PageTitle: './src/components/PageTitle.astro',
				Footer: './src/components/Footer.astro',
				SocialIcons: './src/components/SocialIcons.astro',
				SiteTitle: './src/components/SiteTitle.astro',
				ThemeProvider: './src/components/ThemeProvider.astro',
				ThemeSelect: './src/components/ThemeSelect.astro',
			},
			// docs/schema-docs.md shows the examples' ERDs as <pre class="mermaid">;
			// Mermaid, pinned, draws them in the browser.
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/sql-yodeler/favicon.ico', sizes: '32x32' } },
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://intentius.io/sql-yodeler/hat-share.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '400' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'The SQL Yodeler hat: a pixel-art cowboy hat with a database on it' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://intentius.io/sql-yodeler/hat-share.png' } },
				{
					tag: 'script',
					attrs: { type: 'module' },
					content: "if (document.querySelector('pre.mermaid')) { const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs'); mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default' }); await mermaid.run({ querySelector: 'pre.mermaid' }); }",
				},
			],
		}),
	],
});
