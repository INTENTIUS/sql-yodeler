import type { APIRoute, GetStaticPaths } from 'astro';

// The JSON Schemas of `yodel <command> --json` and of `yodel mcp`'s results,
// served at their `$id` from the package's schemas/ directory.
const files = import.meta.glob<string>('../../../../../schemas/*.schema.json', { eager: true, query: '?raw', import: 'default' });

export const getStaticPaths: GetStaticPaths = () =>
	Object.entries(files).map(([path, text]) => ({
		params: { name: (/([\w-]+)\.schema\.json$/.exec(path) ?? [])[1] },
		props: { text },
	}));

export const GET: APIRoute = ({ props }) =>
	new Response((props as { text: string }).text, { headers: { 'Content-Type': 'application/schema+json; charset=utf-8' } });
