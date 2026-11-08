/**
 * `yodel new` as chant's commit job runs it (#311): `yodel new [<name>]
 * --if-changed --replace-own`, with the name from `ci.new.name` and
 * `CHANT_COMMIT_PR`, and lint's `unmigrated` finding that starts it on the
 * check trigger. Offline: the `postgres` fixture's profiles point at a port
 * nothing listens on.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { yodelFindingExit, yodelFindingTrigger, yodelNewArgs } from "@intentius/chant-lexicon-sql/yodel-run";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readMigrations, writeMigration, createMigration } from "../src/migrations/index.js";
import { offline } from "./helpers/new-suite.js";
import { json, projectFrom, yodel } from "./helpers/run.js";

offline();

const ADD_NOTE: [string, string] = ["amount numeric(12, 2) NOT NULL\n", "amount numeric(12, 2) NOT NULL,\n    note   text\n"];
const ADD_TAG: [string, string] = ["    note   text\n", "    note   text,\n    tag    text\n"];

function edit(dir: string, [from, to]: [string, string]): void {
  const file = join(dir, "src", "schema.ts");
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`schema.ts has no ${JSON.stringify(from)}`);
  writeFileSync(file, text.replace(from, to));
}

const saved = process.env.CHANT_COMMIT_PR;
beforeAll(() => {
  process.env.CHANT_COMMIT_PR = "12";
});
afterAll(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "CHANT_COMMIT_PR");
  else process.env.CHANT_COMMIT_PR = saved;
});

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const d of disposers.splice(0)) d();
});
function project(edit?: (text: string) => string): { dir: string; migrations: string; commit: (...extra: string[]) => string[] } {
  const p = projectFrom("postgres", edit);
  disposers.push(p.dispose);
  // The argv chant's commit job runs, from the sql lexicon.
  return { dir: p.dir, migrations: join(p.dir, "migrations"), commit: (...extra) => [...yodelNewArgs({ dir: p.dir }), ...extra] };
}

const names = (dir: string) => readMigrations(dir).map((m) => m.id.slice(m.id.indexOf("-") + 1));

describe("yodel new in the commit job (#311)", () => {
  it("takes the argv chant runs: no name, pr-<number> from CHANT_COMMIT_PR", async () => {
    const p = project();
    expect(p.commit()).toEqual(["new", "--if-changed", "--replace-own", "--dir", p.dir]);
    const ran = await yodel(p.commit());
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toMatch(/^Wrote migrations\/\d{8}T\d{4}-pr-12\/ /);
    expect(names(p.migrations)).toEqual(["pr-12"]);
  });

  it("writes nothing when the newest migration records the build, and asking twice gives one migration", async () => {
    const p = project();
    expect((await yodel(["new", "init", "--dir", p.dir])).code).toBe(0);
    const before = readMigrations(p.migrations);

    const same = await yodel(p.commit("--json"));
    expect(same.code, same.err).toBe(0);
    expect(json(same)).toMatchObject({ written: false, parent: before[0]?.id });
    expect(readMigrations(p.migrations)).toHaveLength(1);

    // init is not this pull request's: the change goes in a migration of its own, after it.
    edit(p.dir, ADD_NOTE);
    const first = await yodel(p.commit());
    expect(first.code, first.err).toBe(0);
    expect(names(p.migrations)).toEqual(["init", "pr-12"]);

    // pr-12 is: a further change replaces it, from init's recorded schema.
    edit(p.dir, ADD_TAG);
    const again = await yodel(p.commit());
    expect(again.code, again.err).toBe(0);
    expect(again.out).toMatch(/^Replaced \d{8}T\d{4}-pr-12\.\n/);
    expect(again.err).toContain("--replace-own checked no environment's history");
    const after = readMigrations(p.migrations);
    expect(names(p.migrations)).toEqual(["init", "pr-12"]);
    expect(after[1]?.parent).toBe(before[0]?.id);
    expect(after[1]?.files.sql).toContain("note");
    expect(after[1]?.files.sql).toContain("tag");

    // And once more with nothing new: --if-changed compares with pr-12 itself, so nothing is written again.
    const unchanged = await yodel(p.commit());
    expect(unchanged.code, unchanged.err).toBe(0);
    expect(unchanged.out).toContain("No changes: the declared schema matches the newest migration's recorded schema");
    expect(readMigrations(p.migrations).map((m) => m.id)).toEqual(after.map((m) => m.id));
  });

  it("keeps an own migration that holds more than yodel new writes, and follows it", async () => {
    const p = project();
    expect((await yodel(["new", "init", "--dir", p.dir])).code).toBe(0);
    const [init] = readMigrations(p.migrations);
    if (!init) throw new Error("no init");
    // pr-12 with a pre-migration check, written a minute of its own so the next id differs.
    const kept = createMigration({
      name: "pr-12",
      previous: init,
      now: new Date(Date.UTC(2030, 0, 1, 0, 0)),
      checks: [{ name: "no_rows", sql: "SELECT 1 WHERE false" }],
      build: { ...init.document.schema, objects: [...init.document.schema.objects, { export: "extra", type: "Postgres::Table", ddl: "CREATE TABLE extra (id bigint)", dependsOn: [] }] },
    });
    if (kept.id === undefined) throw new Error("no change");
    writeMigration(p.migrations, kept);
    edit(p.dir, ADD_NOTE);
    const ran = await yodel(p.commit());
    expect(ran.code, ran.err).toBe(0);
    expect(ran.err).toContain(`${kept.id} holds pre-migration checks, which --replace-own does not write again, so it is kept`);
    const after = readMigrations(p.migrations);
    expect(after).toHaveLength(3);
    expect(after[1]?.id).toBe(kept.id);
    expect(after[2]?.parent).toBe(kept.id);
  });

  it("takes ci.new.name, with {pr} the number, and refuses one without {pr}", async () => {
    const named = project();
    writeFileSync(join(named.dir, "yodel.config.ts"), 'export default { ci: { new: { name: "schema-{pr}" } } };\n');
    const ran = await yodel(named.commit());
    expect(ran.code, ran.err).toBe(0);
    expect(names(named.migrations)).toEqual(["schema-12"]);

    const bad = project();
    writeFileSync(join(bad.dir, "yodel.config.ts"), 'export default { ci: { new: { name: "schema" } } };\n');
    const refused = await yodel(bad.commit());
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("ci.new.name: a migration name holding {pr}");
  });

  it("refuses --replace with --replace-own, --if-changed with --backfill, and --sql with either", async () => {
    const p = project();
    for (const args of [["x", "--replace", "--replace-own"], ["x", "--if-changed", "--backfill"], ["x", "--sql", "--replace-own"], ["x", "--sql", "--if-changed"], ["x", "--env", "dev"]]) {
      const ran = await yodel(["new", ...args, "--dir", p.dir]);
      expect(ran.code, args.join(" ")).toBe(1);
      expect(ran.err, args.join(" ")).toContain("usage: yodel new [<name>]");
    }
  });
});

describe("yodel lint's unmigrated finding (#311)", () => {
  it("is a warning while the declared schema is ahead of the newest migration, and starts the new commit job", async () => {
    const p = project();
    expect((await yodel(["new", "init", "--dir", p.dir])).code).toBe(0);
    const clean = await yodel(["lint", "--json", "--dir", p.dir]);
    expect(clean.code, clean.err).toBe(0);
    expect((json(clean) as { findings: Array<{ rule: string }> }).findings.map((f) => f.rule)).not.toContain("unmigrated");
    expect(yodelFindingExit(clean.out, "new")).toBe(0);

    edit(p.dir, ADD_NOTE);
    const ahead = await yodel(["lint", "--json", "--dir", p.dir]);
    expect(ahead.code, ahead.err).toBe(0);
    const doc = json(ahead) as { status: string; findings: Array<{ rule: string; level: string; message: string }> };
    const found = doc.findings.find((f) => f.rule === "unmigrated");
    expect(found).toMatchObject({ level: "warning" });
    expect(found?.message).toMatch(/^the declared schema in src is ahead of \d{8}T\d{4}-init's recorded schema by 1 step no migration records/);
    expect(yodelFindingTrigger(ahead.out)).toBe("new");
    expect(yodelFindingExit(ahead.out, "new")).toBe(2);

    expect((await yodel(p.commit())).code).toBe(0);
    const caught = await yodel(["lint", "--json", "--dir", p.dir]);
    expect((json(caught) as { findings: Array<{ rule: string }> }).findings.map((f) => f.rule)).not.toContain("unmigrated");
  });

  it("is an error when lint.rules says so, and says nothing over a fork", async () => {
    const p = project();
    writeFileSync(join(p.dir, "yodel.config.ts"), 'export default { lint: { rules: { unmigrated: "error" } } };\n');
    expect((await yodel(["new", "init", "--dir", p.dir])).code).toBe(0);
    edit(p.dir, ADD_NOTE);
    const ran = await yodel(["lint", "--dir", p.dir]);
    expect(ran.code).toBe(1);
    expect(ran.out).toContain("error    unmigrated: the declared schema in src is ahead of");

    // Two children of init: a fork, which rebase settles first.
    const [init] = readMigrations(p.migrations);
    const schema = init?.document.schema;
    if (!init || !schema) throw new Error("no init");
    for (const [name, minute] of [["a", 1], ["b", 2]] as const) {
      const made = createMigration({ name, previous: init, now: new Date(Date.UTC(2030, 0, 1, 0, minute)), build: { ...schema, objects: [...schema.objects, { export: name, type: "Postgres::Table", ddl: `CREATE TABLE ${name} (id bigint)`, dependsOn: [] }] } });
      if (made.id === undefined) throw new Error("no change");
      writeMigration(p.migrations, made);
    }
    const forked = await yodel(["lint", "--json", "--dir", p.dir]);
    const rules = (json(forked) as { findings: Array<{ rule: string }> }).findings.map((f) => f.rule);
    expect(rules).toContain("fork");
    expect(rules).not.toContain("unmigrated");
    expect(yodelFindingTrigger(forked.out)).toBe("rebase");
  });
});
