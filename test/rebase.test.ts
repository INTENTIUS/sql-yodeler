import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildOutput, BuiltObject } from "../src/chant/build.js";
import {
  computeChecksum,
  createMigration,
  readMigrations,
  scanMigrations,
  verifyChecksum,
  writeMigration,
  type CreatedMigration,
  type Migration,
} from "../src/migrations/index.js";
import { asWritten, mergeChange, planRebase, RebaseConflict, writeRebase, type RebasePlan } from "../src/rebase/index.js";
import { checkRepair, repairRow } from "../src/rebase/repair.js";
import { deriveState, MIGRATION_ROW, type HistoryRow } from "../src/history/index.js";
import { compareHistory } from "../src/versioned/index.js";
import { renderStatus, statusJson } from "../src/versioned/report.js";
import { json, projectFrom, yodel } from "./helpers/run.js";

const DB = "yodel_15";
const db: BuiltObject = { export: "db", type: "ClickHouse::Database", ddl: `CREATE DATABASE ${DB} ENGINE = Atomic`, dependsOn: [] };
const table = (exp: string, name: string, columns = "id UInt64"): BuiltObject => ({
  export: exp,
  type: "ClickHouse::Table",
  ddl: `CREATE TABLE ${DB}.${name} (${columns}) ENGINE = MergeTree ORDER BY id`,
  dependsOn: ["db"],
});
const build = (...objects: BuiltObject[]): BuildOutput => ({ dialect: "clickhouse", objects: [db, ...objects] });

const projects: Array<() => void> = [];
afterEach(() => {
  for (const dispose of projects.splice(0)) dispose();
});

/** A project with a migrations directory; `add` writes a migration after `previous`. */
function project() {
  const { dir, dispose } = projectFrom("clickhouse-versioned");
  projects.push(dispose);
  const migrations = join(dir, "migrations");
  const add = (name: string, minute: number, schema: BuildOutput, previous?: Migration | CreatedMigration): Migration => {
    const prev = previous && "dir" in previous ? previous : previous ? scanMigrations(migrations).migrations.find((m) => m.id === previous.id) : undefined;
    const made = createMigration({ name, build: schema, previous: prev, now: new Date(Date.UTC(2026, 9, 9, 10, minute)) });
    if (made.id === undefined) throw new Error(`no change for ${name}`);
    writeMigration(migrations, made);
    const read = scanMigrations(migrations).migrations.find((m) => m.id === made.id);
    if (!read) throw new Error("not written");
    return read;
  };
  return { dir, migrations, add, scan: () => scanMigrations(migrations).migrations };
}

const rebased = (p: ReturnType<typeof planRebase>): RebasePlan => {
  if (p.moved === undefined) throw new Error("expected a rebase");
  return p;
};

describe("yodel rebase", () => {
  it("moves the newer of a fork onto the other, recomputing its statements, schema and checksum", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const c = p.add("add-c", 20, build(table("a", "a"), table("c", "c")), one);
    expect(() => readMigrations(p.migrations)).toThrow(/fork: .*add-b and .*add-c both follow/);

    const plan = rebased(planRebase(p.scan()));
    expect(plan).toMatchObject({ moved: c.id, from: one.id, onto: b.id });
    expect(plan.rewritten.map((m) => m.id)).toEqual([c.id]);
    writeRebase(plan);

    const chain = readMigrations(p.migrations, { verify: true });
    expect(chain.map((m) => m.id)).toEqual([one.id, b.id, c.id]);
    const moved = chain[2] as Migration;
    expect(moved.parent).toBe(b.id);
    expect(moved.document.schema.objects.map((o) => o.export)).toEqual(["db", "a", "b", "c"]);
    expect(moved.document.steps.map((s) => [s.name, s.kind === "statement" ? s.sql.split(" (")[0] : s.kind])).toEqual([[`${DB}.c`, `CREATE TABLE ${DB}.c`]]);
    expect(moved.document.steps).toHaveLength(1);
    expect(moved.checksum).not.toBe(c.checksum);
    expect(moved.checksum).toBe(computeChecksum(moved.files));
    expect(verifyChecksum(moved).ok).toBe(true);
    expect(moved.files.sql).toContain(`-- parent: ${b.id}`);
    expect(asWritten(moved)).toBe(true);
    // The id is kept, and the moved one's own change is all it makes: a later yodel new from the merged build has nothing to do.
    expect(createMigration({ name: "after", build: build(table("a", "a"), table("b", "b"), table("c", "c")), previous: moved }).id).toBeUndefined();
  });

  it("keeps a backfill step and its module when it moves a migration, and the new checksum covers the module", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const module = "export const op = 1;\n";
    const made = createMigration({ name: "fill", build: build(table("a", "a"), table("c", "c")), previous: one, now: new Date(Date.UTC(2026, 9, 9, 10, 20)), backfill: { text: module } });
    if (made.id === undefined) throw new Error("no change");
    writeMigration(p.migrations, made);

    const plan = rebased(planRebase(p.scan()));
    expect(plan).toMatchObject({ moved: made.id, onto: b.id });
    expect(plan.rewritten[0]?.handEdited).toBe(false);
    writeRebase(plan);

    const moved = readMigrations(p.migrations, { verify: true }).at(-1) as Migration;
    expect(moved.parent).toBe(b.id);
    expect(moved.files.extra).toEqual({ "backfill.ts": module });
    expect(moved.document.steps.map((s) => (s.kind === "op" ? s.op : s.kind))).toEqual(["statement", "backfill"]);
    expect(moved.checksum).toBe(computeChecksum(moved.files));
    expect(moved.checksum).not.toBe(computeChecksum({ sql: moved.files.sql, json: moved.files.json }));
    expect(verifyChecksum(moved).ok).toBe(true);
    expect(asWritten(moved)).toBe(true);
  });

  it("moves the migrations after the moved one with it, onto the end of the other branch", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const b2 = p.add("add-b2", 11, build(table("a", "a"), table("b", "b", "id UInt64, x String DEFAULT ''")), b);
    const c = p.add("add-c", 20, build(table("a", "a"), table("c", "c")), one);
    const d = p.add("add-d", 21, build(table("a", "a"), table("c", "c"), table("d", "d")), c);

    const plan = rebased(planRebase(p.scan()));
    expect(plan).toMatchObject({ moved: c.id, onto: b2.id });
    writeRebase(plan);
    const chain = readMigrations(p.migrations, { verify: true });
    expect(chain.map((m) => m.id)).toEqual([one.id, b.id, b2.id, c.id, d.id]);
    expect((chain[4] as Migration).document.schema.objects.map((o) => o.export)).toEqual(["db", "a", "b", "c", "d"]);
    expect((chain[4] as Migration).document.steps.map((s) => s.name)).toEqual([`${DB}.d`]);
  });

  it("takes a named migration and --onto", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const c = p.add("add-c", 20, build(table("a", "a"), table("c", "c")), one);
    const plan = rebased(planRebase(p.scan(), { id: b.id, onto: c.id }));
    expect(plan).toMatchObject({ moved: b.id, onto: c.id });
    expect(() => planRebase(p.scan(), { id: b.id, onto: one.id })).toThrow(/already follows/);
    expect(() => planRebase(p.scan(), { id: "20261009T1000-nope" })).toThrow(/not in the migrations directory/);
  });

  it("has nothing to do without a fork, and needs --onto for a migration not in one", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const two = p.add("two", 10, build(table("a", "a"), table("b", "b")), one);
    expect(planRebase(p.scan())).toEqual({ moved: undefined });
    expect(() => planRebase(p.scan(), { id: two.id })).toThrow(/not in a fork.*--onto/);
    expect(() => planRebase(p.scan(), { id: one.id, onto: two.id })).toThrow(/cannot be rebased onto/);
  });

  it("refuses when both branches change the same object, naming it", () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    p.add("add-x", 10, build(table("a", "a", "id UInt64, x String DEFAULT ''")), one);
    p.add("add-y", 20, build(table("a", "a", "id UInt64, y String DEFAULT ''")), one);
    const conflict = (() => {
      try {
        planRebase(p.scan());
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(conflict).toBeInstanceOf(RebaseConflict);
    expect((conflict as RebaseConflict).objects).toEqual(["a"]);
    expect((conflict as RebaseConflict).message).toMatch(/both change a, differently.*Nothing was written.*yodel new/);
    expect((conflict as RebaseConflict).exitCode).toBe(4);
  });

  it("refuses one table declared under two export names, and allows the same change on both sides", () => {
    const base = build(table("a", "a"));
    expect(() => mergeChange(base, build(table("a", "a"), table("b", "b")), build(table("a", "a"), table("bee", "b")), { migration: "m", theirs: "t" })).toThrow(/both change b \/ bee/);
    const same = build(table("a", "a"), table("b", "b"));
    expect(mergeChange(base, same, same, { migration: "m", theirs: "t" }).objects.map((o) => o.export)).toEqual(["db", "a", "b"]);
    // A drop on one side, an add on the other.
    const merged = mergeChange(build(table("a", "a"), table("b", "b")), build(table("a", "a")), build(table("a", "a"), table("b", "b"), table("c", "c")), { migration: "m", theirs: "t" });
    expect(merged.objects.map((o) => o.export)).toEqual(["db", "a", "c"]);
  });

  it("refuses from the command when a migration to rewrite was edited by hand, unless --force", async () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const c = p.add("add-c", 20, build(table("a", "a"), table("c", "c")), one);
    const sql = join(c.dir, "migration.sql");
    writeFileSync(sql, `-- yodel:allow SQLCH250 reviewed\n${readFileSync(sql, "utf8")}`);

    const refused = await yodel(["rebase", "--dir", p.dir]);
    expect(refused.code).toBe(4);
    expect(refused.err).toContain(`${c.id} has files that differ from what yodel wrote`);
    expect(() => readMigrations(p.migrations)).toThrow(/fork/);

    const forced = await yodel(["rebase", "--force", "--json", "--dir", p.dir]);
    expect(forced.code, forced.err).toBe(0);
    expect(json(forced)).toMatchObject({ rebased: true, moved: c.id, onto: b.id, rewritten: [{ id: c.id, parent: b.id, oldParent: one.id, handEdited: true }] });
    expect(readMigrations(p.migrations, { verify: true }).map((m) => m.id)).toEqual([one.id, b.id, c.id]);

    const again = await yodel(["rebase", "--dir", p.dir]);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("Nothing to rebase");
  });

  it("prints what it rewrote", async () => {
    const p = project();
    const one = p.add("one", 0, build(table("a", "a")));
    const b = p.add("add-b", 10, build(table("a", "a"), table("b", "b")), one);
    const c = p.add("add-c", 20, build(table("a", "a"), table("c", "c")), one);
    const ran = await yodel(["rebase", c.id, "--onto", b.id, "--dir", p.dir]);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain(`Rebased ${c.id} onto ${b.id} (it followed ${one.id}).`);
    expect(ran.out).toMatch(new RegExp(`${c.id}: follows ${b.id}; 1 statement; checksum ${c.checksum} -> sha256:[0-9a-f]{64}`));
    expect(ran.out).toContain("No history was checked");
  });
});

describe("yodel repair", () => {
  const p = () => project();
  const run = { runId: "run-1", appliedBy: "ci@host", planDigest: "jcs1-sha256:abc" };
  const row = (seq: number, m: Migration, checksum: string, status: HistoryRow["status"], kind: HistoryRow["kind"] = "migration", index = MIGRATION_ROW): HistoryRow => ({
    seq,
    run_id: "apply-1",
    kind,
    migration_id: m.id,
    parent: m.parent ?? "",
    checksum,
    statement_index: index,
    statement_sha: "",
    status,
    error: "",
    applied_by: "ci@host",
    plan_digest: "jcs1-sha256:abc",
    silences: "[]",
    note: "",
  });

  it("builds the migration row that compareHistory honors, with the reason", () => {
    const { add } = p();
    const one = add("one", 0, build(table("a", "a")));
    const editedFiles = { ...one.files, sql: `${one.files.sql}-- reformatted\n` };
    const edited: Migration = { ...one, files: editedFiles };
    const history = [row(1, one, one.checksum, "started"), row(2, one, one.checksum, "succeeded")];

    const before = compareHistory([edited], deriveState(history));
    expect(before.mismatches).toMatchObject([{ kind: "applied", id: one.id, recorded: one.checksum }]);

    const check = checkRepair(edited, one.id, deriveState(history), "e2e");
    expect(check).toMatchObject({ oldChecksum: one.checksum, newChecksum: computeChecksum(editedFiles) });
    const r = repairRow({ migration: edited, check, reason: "  a server upgrade reformatted it  ", run, seq: 3 });
    expect(r).toEqual({
      seq: 3,
      run_id: "run-1",
      kind: "migration",
      migration_id: one.id,
      parent: "",
      checksum: computeChecksum(editedFiles),
      statement_index: -1,
      statement_sha: "",
      status: "succeeded",
      error: "",
      applied_by: "ci@host",
      plan_digest: "jcs1-sha256:abc",
      silences: "[]",
      note: "a server upgrade reformatted it",
    });

    const after = compareHistory([edited], deriveState([...history, r]));
    expect(after.mismatches).toEqual([]);
    expect(after.applied).toMatchObject([{ id: one.id, checksum: computeChecksum(editedFiles) }]);
    expect(deriveState([...history, r]).byId.get(one.id)?.appliedSeq).toBe(2);
    expect((before.mismatches[0] as { message: string }).message).toContain(`if the edit is intended, record it with yodel repair ${one.id} --reason ... <env>`);
    expect((before.mismatches[0] as { message: string }).message).not.toMatch(/\(#\d+\)/);
    expect(() => repairRow({ migration: edited, check, reason: "  ", run, seq: 3 })).toThrow(/needs a reason/);
  });

  it("keeps when and by whom a repaired migration was applied, and lists the repair after it", () => {
    const { add } = p();
    const one = add("one", 0, build(table("a", "a")));
    const editedFiles = { ...one.files, sql: `${one.files.sql}-- reformatted\n` };
    const edited: Migration = { ...one, files: editedFiles };
    const at = (r: HistoryRow, recorded_at: string): HistoryRow => ({ ...r, recorded_at });
    const history = [at(row(1, one, one.checksum, "started"), "2026-10-09 20:00:00.000000"), at(row(2, one, one.checksum, "succeeded"), "2026-10-09 20:00:01.000000")];
    const check = checkRepair(edited, one.id, deriveState(history), "e2e");
    const repair = at(repairRow({ migration: edited, check, reason: "a server upgrade reformatted it", run: { ...run, appliedBy: "bob@laptop" }, seq: 3 }), "2026-10-09 21:30:00.000000");

    const status = compareHistory([edited], deriveState([...history, repair]));
    expect(status.applied).toEqual([
      {
        id: one.id,
        checksum: computeChecksum(editedFiles),
        appliedBy: "ci@host",
        recordedAt: "2026-10-09 20:00:01.000000",
        planDigest: "jcs1-sha256:abc",
        index: 0,
        repairs: [{ checksum: computeChecksum(editedFiles), by: "bob@laptop", at: "2026-10-09 21:30:00.000000", reason: "a server upgrade reformatted it", seq: 3 }],
      },
    ]);
    const report = { environment: "e2e", location: { database: "yodeler", topology: { kind: "single" as const } }, status };
    const text = renderStatus(report);
    expect(text).toContain(`  ${one.id}  2026-10-09 20:00:01.000000 by ci@host\n      repaired 2026-10-09 21:30:00.000000 by bob@laptop: a server upgrade reformatted it\n`);
    expect(statusJson(report).applied).toMatchObject([{ recordedAt: "2026-10-09 20:00:01.000000", appliedBy: "ci@host", repairs: [{ by: "bob@laptop", at: "2026-10-09 21:30:00.000000", reason: "a server upgrade reformatted it" }] }]);
  });

  it("refuses a migration not applied, part way, already matching, or gone from the directory", () => {
    const { add } = p();
    const one = add("one", 0, build(table("a", "a")));
    expect(() => checkRepair(one, one.id, deriveState([]), "e2e")).toThrow(/has not run in e2e/);
    expect(() => checkRepair(one, one.id, deriveState([row(1, one, one.checksum, "failed")]), "e2e")).toThrow(/not applied in e2e: it ran part way/);
    expect(() => checkRepair(one, one.id, deriveState([row(1, one, one.checksum, "succeeded")]), "e2e")).toThrow(/already hash to the checksum/);
    expect(() => checkRepair(undefined, one.id, deriveState([row(1, one, one.checksum, "succeeded")]), "e2e")).toThrow(/no longer has it/);
    try {
      checkRepair(one, one.id, deriveState([]), "e2e");
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(4);
    }
  });

  it("needs a reason", async () => {
    const noReason = await yodel(["repair", "20261009T1000-one", "e2e"]);
    expect(noReason.code).toBe(1);
    expect(noReason.err).toContain("a repair needs a reason");
    const usage = await yodel(["repair", "20261009T1000-one", "--reason", "x"]);
    expect(usage.code).toBe(1);
    expect(usage.err).toContain('usage: yodel repair <env> <id> --reason "<text>"');

  });
});
