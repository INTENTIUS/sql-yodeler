/**
 * `yodel plan`'s access review and a REVOKE that chant files under SQLPG296
 * beside a grant (#398), on both paths:
 *
 * - versioned: a pending migration that swaps INSERT for UPDATE; the plan
 *   lists each pending migration's access steps and the ones taking access
 *   away;
 * - declarative, access on: INSERT granted by hand, then UPDATE declared;
 *   the plan's access section marks a revoke of a hand-made grant.
 *
 *   YODEL_E2E_PREFIX=yodel_398 \
 *   YODEL_E2E_POSTGRES_URL=postgres://<host>:5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/access-revoke-plan.test.ts
 *
 * The role <prefix>_writer must exist. The schemas stay on the server.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "@intentius/chant/chant-install";
import type { BuildOutput, BuiltObject } from "../../src/chant/build.js";
import { createMigration, newestMigration, readMigrations, writeMigration } from "../../src/migrations/index.js";
import { json, yodel } from "../helpers/run.js";
import { postgres, postgresReachable } from "./emulator.js";
import { e2eProject, PREFIX, suiteName } from "./names.js";

const W = `${PREFIX}_writer`;

describe.skipIf(!postgresReachable)("yodel plan on a versioned swap", () => {
  const S = suiteName("revoke_versioned");
  const HISTORY = `${S}_history`;
  let dir = "";
  let dispose = (): void => undefined;
  const saved = process.env.YODEL_HISTORY_DATABASE;
  const at = (...args: string[]) => [...args, "--dir", dir];
  let text = "";

  beforeAll(async () => {
    process.env.YODEL_HISTORY_DATABASE = HISTORY;
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
    ({ dir, dispose } = e2eProject("lint-postgres", S));
    const app: BuiltObject = { export: "app", type: "Postgres::Schema", ddl: `CREATE SCHEMA ${S}`, dependsOn: [] };
    const orders: BuiltObject = { export: "orders", type: "Postgres::Table", ddl: `CREATE TABLE ${S}.orders (id bigint PRIMARY KEY)`, dependsOn: ["app"] };
    const grant = (p: string): BuiltObject => ({ export: "w", type: "Postgres::Grant", ddl: `GRANT ${p} ON TABLE ${S}.orders TO ${W}`, dependsOn: ["orders"] });
    const builds: BuildOutput[] = [
      { dialect: "postgres", postgresMajor: 18, objects: [app, orders, grant("INSERT")] },
      { dialect: "postgres", postgresMajor: 18, objects: [app, orders, grant("UPDATE")] },
    ];
    const migrations = join(dir, "migrations");
    builds.forEach((build, i) => {
      const m = createMigration({ name: `m${String(i)}`, build, previous: newestMigration(readMigrations(migrations)), now: new Date(Date.UTC(2026, 10, 21, 13, i)) });
      if (m.id === undefined) throw new Error(`no change at ${String(i)}`);
      writeMigration(migrations, m);
    });
    const ran = await yodel(at("plan", "e2e"));
    expect(ran.code, ran.err).toBe(0);
    text = ran.out;
  });
  afterAll(() => {
    dispose();
    if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
    else process.env.YODEL_HISTORY_DATABASE = saved;
  });

  it("lists the swap's two steps under access control and names its REVOKE as taking access away", () => {
    expect(text).toMatch(/Access control: 2 steps \(SQLPG296 metadata\), 1 taking access away:/);
    expect(text).toMatch(/step 0 revokes a privilege: REVOKE INSERT ON TABLE/);
    expect(text).not.toMatch(/revokes a privilege: GRANT UPDATE/);
  });
});

describe.skipIf(!postgresReachable)("yodel plan's access section on the declarative path, access on", () => {
  const S = suiteName("revoke_declarative");
  let dir = "";
  let dispose = (): void => undefined;
  const at = (...args: string[]) => [...args, "--dir", dir];
  interface Item {
    object: string;
    rule: string;
    before?: unknown;
    after?: unknown;
    byHand?: boolean;
  }
  const items = async (): Promise<{ items: Item[]; text: string }> => {
    const ran = await yodel(at("plan", "e2e", "--json"));
    expect(ran.code, ran.err).toBe(0);
    const text = await yodel(at("plan", "e2e"));
    const doc = json(ran) as { access?: { changes: Item[] } };
    return { items: (doc.access?.changes ?? []).filter((c) => c.object === `relation ${S}.orders TO ${W}`), text: text.out };
  };

  beforeAll(async () => {
    await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    ({ dir, dispose } = e2eProject("postgres", S));
    const config = join(dir, "chant.config.ts");
    writeFileSync(config, readFileSync(config, "utf8").replace(`schemas: ["${S}"],`, `schemas: ["${S}"],\n        access: true,`));
    const first = await yodel(at("apply", "e2e", "--json"));
    expect(first.code, first.err).toBe(3);
    const command = String((json(first) as { chantApprove?: string }).chantApprove);
    expect(command).toMatch(/^chant approve /);
    const ran = await runChant(command.split(" ").slice(1), { cwd: dir, noColor: true, resolveFallback: true });
    expect(ran.code, ran.stderr).toBe(0);
    const second = await yodel(at("apply", "e2e", "--json"));
    expect(second.code, second.err).toBe(0);
    await postgres(`GRANT INSERT ON ${S}.orders TO ${W}`);
  }, 120_000);
  afterAll(() => {
    dispose();
  });

  it("a hand-made INSERT with nothing declared is a SQLPG297 revoke marked byHand", async () => {
    const { items: got, text } = await items();
    expect(got.map((c) => [c.rule, c.before, c.byHand])).toEqual([["SQLPG297", "insert", true]]);
    expect(text).toContain(`relation ${S}.orders FROM ${W}: insert`);
  });

  it("with UPDATE declared, the same revoke becomes one SQLPG296 change (insert -> update)", async () => {
    const file = join(dir, "src", "schema.ts");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nimport { grant } from "@intentius/chant-lexicon-sql/postgres";\nexport const writeOrders = grant\`GRANT UPDATE ON \${orders} TO ${W}\`;\n`);
    const { items: got } = await items();
    expect(got.map((c) => [c.rule, c.before, c.after])).toEqual([["SQLPG296", "insert", "update"]]);
  });

  it("marks that SQLPG296 change byHand and lists it under Revoked by this apply", async () => {
    const { items: got, text } = await items();
    expect(got[0]?.byHand).toBe(true);
    expect(text).toContain(`relation ${S}.orders FROM ${W}: insert`);
  });
});
