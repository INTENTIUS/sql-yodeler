import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				// The page's prompt for a coding agent, from prompts.mjs (pages.mjs
				// writes it). The page header shows it; llms.txt and llms-full.txt carry it.
				prompt: z.string().optional(),
				// The page's place in the sidebar, for llms.txt's order (pages.mjs writes it).
				rank: z.number().optional(),
			}),
		}),
	}),
};
