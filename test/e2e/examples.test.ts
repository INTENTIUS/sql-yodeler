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
 * The committed examples and their transcripts use database or schema shop
 * and history yodeler. Here every one of those names is taken from
 * YODEL_E2E_PREFIX instead, <prefix>_ex_shop and <prefix>_ex_yodeler, in the
 * copy each run makes (examples/walkthrough/run.ts, Names), so a run on a
 * shared emulator stays inside its prefix. Each run drops them first, the
 * replay check at the end of each walkthrough empties them, and the suite
 * drops them again after, with the walkthrough's receipts in chant's shared
 * chant_receipts.receipts on ClickHouse (the walkthrough's own reset), so a
 * run leaves nothing behind.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { load, renamer, repoRoot, runCommitted, runWalkthrough, type Names } from "../../examples/walkthrough/run.js";
import { clickhouseReachable, postgresReachable } from "./emulator.js";
import { suiteName } from "./names.js";

const built = existsSync(join(repoRoot, "dist", "bin.js"));
const reachable = { clickhouse: clickhouseReachable, postgres: postgresReachable };
const names: Names = [
  ["shop", suiteName("ex_shop")],
  ["yodeler", suiteName("ex_yodeler")],
];

describe.each(["clickhouse", "postgres"] as const)("examples/%s", (dialect) => {
  afterAll(async () => {
    if (reachable[dialect]) await (await load(dialect)).reset(renamer(names));
  });

  it.skipIf(!reachable[dialect])("runs the walkthrough as the README shows it", async () => {
    if (!built) throw new Error("run npm run build first: the examples run dist/bin.js");
    const { dispose } = await runWalkthrough(await load(dialect), undefined, { names });
    dispose();
  }, 1_800_000);

  it.skipIf(!reachable[dialect])("the committed project applies to an empty database, with no drift after", async () => {
    if (!built) throw new Error("run npm run build first: the examples run dist/bin.js");
    const { dispose } = await runCommitted(await load(dialect), undefined, names);
    dispose();
  }, 900_000);
});
