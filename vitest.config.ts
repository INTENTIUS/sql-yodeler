import { defineConfig } from "vitest/config";

// The e2e files need a server (YODEL_E2E_CLICKHOUSE_URL, YODEL_E2E_POSTGRES_URL,
// YODEL_E2E_FORGEJO_API, ...) and skip themselves without one, but importing
// them still loads chant. With no YODEL_E2E_ variable set they are left out.
const e2e = Object.keys(process.env).some((k) => k.startsWith("YODEL_E2E_"));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: e2e ? ["**/node_modules/**"] : ["**/node_modules/**", "test/e2e/**"],
    testTimeout: 60_000,
    // chant and its sql lexicon ship TypeScript source, and chant imports the
    // project's chant.config.ts and *.op.ts itself. The workers load them the
    // way the yodel bin does: with Node, under tsx, not through Vite.
    execArgv: ["--import", "tsx"],
    server: { deps: { external: [/node_modules\/@intentius\//] } },
  },
});
