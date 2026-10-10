// A docs page as plain Markdown, for llms-full.txt and the "Copy page as
// Markdown" button.
import { pageUrl } from '../prompts.mjs';

export { pageUrl };

export function pageMarkdown(page: { title: string; url: string; prompt?: string; body: string }): string {
	const prompt = page.prompt ? `## Optional: hand this page to your coding agent\n\n\`\`\`text\n${page.prompt}\n\`\`\`\n\n` : '';
	return `# ${page.title}\n\nSource: ${page.url}\n\n${prompt}${page.body.trim()}`;
}
