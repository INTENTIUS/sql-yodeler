/**
 * The examples (#18) stay true: each walkthrough in examples/walkthrough runs
 * end to end against the emulator, with the exit codes and output its README
 * shows, and the committed example project applies to an empty database.
 *
 * Gated like the other e2e suites, and run after `npm run build` (the
 * examples run the yodel bin):
 *
 *   npm run build && YODEL_E2E_CLICKHOUSE_URL=http://$(ipconfig getifaddr en0):8123 \
 *     YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *     YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *     npx vitest run test/e2e/examples.test.ts
 *
 * ClickHouse database yodel_18_shop and yodel_18_history, Postgres schemas of
 * the same names; each run drops them first. The replay check at the end of
 * each walkthrough empties them, and the suite drops them again after, with
 * the walkthrough's receipts in chant's shared chant_receipts.receipts on
 * ClickHouse (the walkthrough's own reset), so a run leaves nothing behind. These names are fixed, not taken from
 * YODEL_E2E_PREFIX: the committed example migrations carry them.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { load, repoRoot, runCommitted, runWalkthrough } from "../../examples/walkthrough/run.js";
import { clickhouseReachable, postgresReachable } from "./emulator.js";

const built = existsSync(join(repoRoot, "dist", "bin.js"));
const reachable = { clickhouse: clickhouseReachable, postgres: postgresReachable };

describe.each(["clickhouse", "postgres"] as const)("examples/%s", (dialect) => {
  afterAll(async () => {
    if (reachable[dialect]) await (await load(dialect)).reset();
  });

  it.skipIf(!reachable[dialect])("runs the walkthrough as the README shows it", async () => {
    if (!built) throw new Error("run npm run build first: the examples run dist/bin.js");
    const { dispose } = await runWalkthrough(await load(dialect));
    dispose();
  }, 1_800_000);

  it.skipIf(!reachable[dialect])("the committed project applies to an empty database, with no drift after", async () => {
    if (!built) throw new Error("run npm run build first: the examples run dist/bin.js");
    const { dispose } = await runCommitted(await load(dialect));
    dispose();
  }, 900_000);
});
