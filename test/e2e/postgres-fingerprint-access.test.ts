/**
 * The Postgres plan digest against access changes made on the server after
 * it was computed (#397): grants and revokes on a table, a sequence, a
 * function and the schema, and default privileges, move it whatever the
 * profile's `access` says; policies and row-level security move it where
 * `access` is on. An approval given before such a change does not carry
 * over: `yodel apply --execute` on it exits 4.
 *
 * Each case reads the digest `yodel status <env> --json` reports (the one the
 * migrations Op's gate binds), makes one change on the server, reads it
 * again, puts the change back and checks the digest is where it started. The
 * suite runs twice, with the profile's `access` unset and with it on.
 *
 * Objects in schemas <prefix>_fp_off and <prefix>_fp_on, the history in
 * <schema>_history; roles <prefix>_reader and <prefix>_writer, made when
 * missing (./names.ts):
 *
 *   YODEL_E2E_POSTGRES_URL=postgres://$(ipconfig getifaddr en0):5432/postgres \
 *   YODEL_E2E_POSTGRES_USER=postgres YODEL_E2E_POSTGRES_PASSWORD=chant \
 *   npx vitest run test/e2e/postgres-fingerprint-access.test.ts
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChant } from "@intentius/chant/chant-install";
import { createMigration, readMigrations, writeMigration } from "../../src/migrations/index.js";
import { json, yodel } from "../helpers/run.js";
import { postgres, postgresReachable } from "./emulator.js";
import { loadProject } from "../../src/project.js";
import { e2eProject, PREFIX, suiteName } from "./names.js";

const READER = `${PREFIX}_reader`;
const WRITER = `${PREFIX}_writer`;

interface Case {
  name: string;
  change: string;
  undo: string;
  /** Whether the digest moves, by the profile's `access`. */
  moves: { off: boolean; on: boolean };
}

const cases = (S: string): Case[] => [
  { name: "a column added out of band", change: `ALTER TABLE ${S}.orders ADD COLUMN extra int`, undo: `ALTER TABLE ${S}.orders DROP COLUMN extra`, moves: { off: true, on: true } },
  { name: "GRANT SELECT on a table", change: `GRANT SELECT ON ${S}.orders TO ${READER}`, undo: `REVOKE SELECT ON ${S}.orders FROM ${READER}`, moves: { off: true, on: true } },
  { name: "REVOKE INSERT on a table", change: `REVOKE INSERT ON ${S}.orders FROM ${WRITER}`, undo: `GRANT INSERT ON ${S}.orders TO ${WRITER}`, moves: { off: true, on: true } },
  { name: "GRANT USAGE on a sequence", change: `GRANT USAGE ON SEQUENCE ${S}.seq TO ${READER}`, undo: `REVOKE USAGE ON SEQUENCE ${S}.seq FROM ${READER}`, moves: { off: true, on: true } },
  { name: "REVOKE EXECUTE on a function from PUBLIC", change: `REVOKE EXECUTE ON FUNCTION ${S}.n() FROM PUBLIC`, undo: `GRANT EXECUTE ON FUNCTION ${S}.n() TO PUBLIC`, moves: { off: true, on: true } },
  { name: "GRANT USAGE on the schema", change: `GRANT USAGE ON SCHEMA ${S} TO ${READER}`, undo: `REVOKE USAGE ON SCHEMA ${S} FROM ${READER}`, moves: { off: true, on: true } },
  {
    name: "ALTER DEFAULT PRIVILEGES in the schema",
    change: `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} GRANT SELECT ON TABLES TO ${READER}`,
    undo: `ALTER DEFAULT PRIVILEGES IN SCHEMA ${S} REVOKE SELECT ON TABLES FROM ${READER}`,
    moves: { off: true, on: true },
  },
  { name: "CREATE POLICY", change: `CREATE POLICY added ON ${S}.orders FOR SELECT USING (true)`, undo: `DROP POLICY added ON ${S}.orders`, moves: { off: false, on: true } },
  { name: "ALTER POLICY", change: `ALTER POLICY keep ON ${S}.orders USING (false)`, undo: `ALTER POLICY keep ON ${S}.orders USING (true)`, moves: { off: false, on: true } },
  { name: "DROP POLICY", change: `DROP POLICY keep ON ${S}.orders`, undo: `CREATE POLICY keep ON ${S}.orders FOR SELECT USING (true)`, moves: { off: false, on: true } },
  { name: "DISABLE ROW LEVEL SECURITY", change: `ALTER TABLE ${S}.orders DISABLE ROW LEVEL SECURITY`, undo: `ALTER TABLE ${S}.orders ENABLE ROW LEVEL SECURITY`, moves: { off: false, on: true } },
  { name: "NO FORCE ROW LEVEL SECURITY", change: `ALTER TABLE ${S}.orders NO FORCE ROW LEVEL SECURITY`, undo: `ALTER TABLE ${S}.orders FORCE ROW LEVEL SECURITY`, moves: { off: false, on: true } },
];

function suite(mode: "off" | "on"): void {
  const S = suiteName(`fp_${mode}`);
  const HISTORY = `${S}_history`;

  describe.skipIf(!postgresReachable)(`the plan digest, profile access ${mode}`, () => {
    let dir = "";
    let dispose = (): void => undefined;
    const saved = process.env.YODEL_HISTORY_DATABASE;
    const at = (...args: string[]) => [...args, "--dir", dir];

    const digest = async (): Promise<string> => {
      const ran = await yodel(at("status", "e2e", "--json"));
      expect(ran.code, ran.err).toBe(3);
      const d = (json(ran) as { planDigest?: string }).planDigest;
      expect(d).toMatch(/^jcs1-sha256:/);
      return String(d);
    };

    beforeAll(async () => {
      process.env.YODEL_HISTORY_DATABASE = HISTORY;
      await postgres(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER}') THEN CREATE ROLE ${READER} NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WRITER}') THEN CREATE ROLE ${WRITER} NOLOGIN; END IF;
      END $$`);
      await postgres(`DROP SCHEMA IF EXISTS ${S} CASCADE; DROP SCHEMA IF EXISTS ${HISTORY} CASCADE`);
      await postgres(`
        CREATE SCHEMA ${S};
        CREATE TABLE ${S}.orders (id bigint PRIMARY KEY, tenant text);
        CREATE SEQUENCE ${S}.seq;
        CREATE FUNCTION ${S}.n() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        ALTER TABLE ${S}.orders ENABLE ROW LEVEL SECURITY;
        ALTER TABLE ${S}.orders FORCE ROW LEVEL SECURITY;
        CREATE POLICY keep ON ${S}.orders FOR SELECT USING (true);
        GRANT INSERT ON ${S}.orders TO ${WRITER};`);
      ({ dir, dispose } = e2eProject("postgres-versioned", S));
      if (mode === "on") {
        const { readFileSync, writeFileSync } = await import("node:fs");
        const config = join(dir, "chant.config.ts");
        writeFileSync(config, readFileSync(config, "utf8").replace("lockTimeoutMs: 500,", "lockTimeoutMs: 500,\n        access: true,"));
      }
      // One pending migration, so status and apply have a plan to digest.
      const m = createMigration({
        name: "b",
        build: { dialect: "postgres", objects: [{ export: "b", type: "Postgres::Table", ddl: `CREATE TABLE ${S}.b (id bigint PRIMARY KEY)`, dependsOn: [] }] },
        previous: readMigrations(join(dir, "migrations")).at(-1),
        now: new Date(Date.UTC(2026, 10, 21, 12, 0)),
      });
      if (m.id === undefined) throw new Error("no change");
      writeMigration(join(dir, "migrations"), m);
    });
    afterAll(() => {
      dispose();
      if (saved === undefined) delete process.env.YODEL_HISTORY_DATABASE;
      else process.env.YODEL_HISTORY_DATABASE = saved;
      // The schemas stay on the server, for inspection; the next run drops them first.
    });

    it("reads the profile's access setting as given", async () => {
      const project = await loadProject(dir);
      expect(project.profileAccess?.e2e).toBe(mode === "on" ? true : undefined);
    });

    for (const c of cases(S)) {
      const moves = c.moves[mode];
      it(`${c.name} ${moves ? "moves the digest" : "leaves the digest where it was"}`, async () => {
        const before = await digest();
        await postgres(c.change);
        try {
          if (moves) expect(await digest()).not.toBe(before);
          else expect(await digest()).toBe(before);
        } finally {
          await postgres(c.undo);
        }
        expect(await digest()).toBe(before);
      });
    }

    const approve = async (): Promise<string> => {
      const gated = await yodel(at("apply", "e2e", "--json"));
      expect(gated.code, gated.err).toBe(3);
      const doc = json(gated) as { planDigest: string; chantApprove?: string };
      expect(doc.chantApprove).toMatch(/^chant approve migrate-e2e approve-migrate-e2e --plan jcs1-sha256:[0-9a-f]{64}$/);
      const ran = await runChant(String(doc.chantApprove).split(" ").slice(1), { cwd: dir, noColor: true, resolveFallback: true });
      expect(ran.code, ran.stderr).toBe(0);
      return doc.planDigest;
    };
    const execute = async (approved: string) => {
      process.env.YODEL_APPROVED_PLAN = approved;
      try {
        return await yodel(at("apply", "e2e", "--execute"));
      } finally {
        delete process.env.YODEL_APPROVED_PLAN;
      }
    };

    // Each change below stays: put back, the digest would be one that already holds an approval, and the next apply would run on it.
    it("an approval does not carry over a column added after it (exit 4)", async () => {
      const approved = await approve();
      await postgres(`ALTER TABLE ${S}.orders ADD COLUMN later int`);
      const ran = await execute(approved);
      expect(ran.code, ran.err).toBe(4);
    });

    const refusals = [
      { name: "a GRANT", change: `GRANT SELECT ON ${S}.orders TO ${READER}`, modes: ["off", "on"] },
      { name: "a dropped policy", change: `DROP POLICY keep ON ${S}.orders`, modes: ["on"] },
      { name: "row-level security turned off", change: `ALTER TABLE ${S}.orders DISABLE ROW LEVEL SECURITY`, modes: ["on"] },
    ].filter((r) => r.modes.includes(mode));
    for (const r of refusals) {
      it(`an approval does not carry over ${r.name} made after it (exit 4)`, async () => {
        const approved = await approve();
        await postgres(r.change);
        const ran = await execute(approved);
        expect(ran.code, ran.err).toBe(4);
        expect(ran.err).toMatch(/digest/);
      });
    }
  });
}

suite("off");
suite("on");
