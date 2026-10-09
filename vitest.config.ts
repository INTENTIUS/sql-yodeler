import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // chant and its sql lexicon ship TypeScript source, and chant imports the
    // project's chant.config.ts and *.op.ts itself. The workers load them the
    // way the yodel bin does: with Node, under tsx, not through Vite.
    execArgv: ["--import", "tsx"],
    server: { deps: { external: [/node_modules\/@intentius\//] } },
  },
});
