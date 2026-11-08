/**
 * `yodel new --if-changed --replace-own` against the emulator's Postgres
 * (#311): the commit job's argv writes pr-<number>, the migration is applied
 * behind the gate, and from then on `--replace-own --env e2e` refuses to
 * replace it in the words chant's refusal reply reads
 * (`yodelRefusalReply`, the sql lexicon's `yodel-run.ts`).
 *
 * Objects in schema <prefix>_new_ci, the history in <prefix>_new_ci_history:
 *
 *   YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/new-ci.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { yodelNewArgs, yodelRefusalReply } from "@intentius/chant-lexicon-sql/yodel-run";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "../../src/chant/process.js";
import { readMigrations } from "../../src/migrations/index.js";
import { json, yodel } from "../helpers/run.js";
import { postgres, postgresReachable } from "./emulator.js";
import { e2eProject, suiteName } from "./names.js";

const S = suiteName("new_ci");
const HISTORY = `${S}_history`;

const schemaTs = (columns: string) => `import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema\`CREATE SCHEMA ${S}\`;

export const orders = table\`
  CREATE TABLE \${app}.orders (
    ${columns}
  )\`;
`;

describe.skipIf(!postgresReachable)("yodel new --replace-own on postgres (#311)", () => {
  let dir = "";
  let dispose = (): void => undefined;
  const saved = { history: process.env.YODEL_HISTORY_DATABASE, pr: process.env.CHANT_COMMIT_PR };
  const declare = (columns: string) => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "schema.ts"), schemaTs(columns));
  };

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    process.env.CHANT_COMMIT_PR = "41";
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    ({ dir, dispose } = e2eProject("postgres-versioned", S));
  });
  afterAll(async () => {
    dispose();
    for (const [k, v] of [["YODEL_HISTORY_DATABASE", saved.history], ["CHANT_COMMIT_PR", saved.pr]] as const) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
  });

  it("replaces pr-41 until it is applied, then refuses in the words chant's reply reads", async () => {
    declare("id bigint PRIMARY KEY");
    const wrote = await yodel(yodelNewArgs({ dir }));
    expect(wrote.code, wrote.err).toBe(0);
    const [own] = readMigrations(join(dir, "migrations"));
    expect(own?.id).toMatch(/-pr-41$/);

    // Not applied yet: --env e2e reads the history, finds nothing, and the change replaces pr-41.
    declare("id bigint PRIMARY KEY, note text");
    const replaced = await yodel([...yodelNewArgs({ dir }), "--env", "e2e"]);
    expect(replaced.code, replaced.err).toBe(0);
    expect(replaced.out).toMatch(/^Replaced \d{8}T\d{4}-pr-41\.\n/);
    const migrations = readMigrations(join(dir, "migrations"));
    expect(migrations).toHaveLength(1);
    const applied = migrations[0];
    if (!applied) throw new Error("no migration");

    // Applied behind the gate.
    const gated = await yodel(["apply", "e2e", "--json", "--dir", dir]);
    expect(gated.code, gated.err).toBe(3);
    const approve = (json(gated) as { chantApprove?: string }).chantApprove ?? "";
    const approved = await runChant(approve.split(" ").slice(1), { cwd: dir });
    expect(approved.code, approved.stderr).toBe(0);
    const ran = await yodel(["apply", "e2e", "--json", "--dir", dir]);
    expect(ran.code, ran.err).toBe(0);

    declare("id bigint PRIMARY KEY, note text, tag text");
    const argv = [...yodelNewArgs({ dir }), "--env", "e2e"];
    const refused = await yodel(argv);
    expect(refused.code).toBe(1);
    const last = refused.err.trim().split("\n").at(-1);
    expect(last).toBe(`yodel new: refused: ${applied.id} is applied in e2e, so it is not replaced; write the change as a new migration (yodel new <name>). Nothing written.`);
    expect(readMigrations(join(dir, "migrations")).map((m) => m.id)).toEqual([applied.id]);
    expect(readFileSync(join(applied.dir, "migration.sql"), "utf8")).not.toContain("tag");

    const reply = yodelRefusalReply({ command: ["yodel", ...argv], rc: "1", output: refused.err });
    expect(reply).toBe(`\`yodel new\` refused: \`${applied.id}\` is applied in \`e2e\`, so it is not replaced. Write the change as a migration of its own: \`yodel new <name>\`.`);
  }, 120_000);
});
