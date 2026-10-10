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
				// The scenario claims that prove the page, from its front matter in docs/
				// (pages.mjs writes it; npm run check holds each to the claims record).
				claims: z.array(z.string()).default([]),
				// A draft page whose claims do not all hold yet: llms.txt leaves it out.
				unproven: z.boolean().optional(),
			}),
		}),
	}),
};
