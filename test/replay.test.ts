/**
 * The replay check's walk over a history, against a fake driver: what it
 * sends, where it stops, what it names, and that the target is fresh before
 * and emptied after.
 */

import { describe, expect, it } from "vitest";
import type { BuildOutput } from "../src/chant/build.js";
import { createMigration, type Migration, type MigrationStep } from "../src/migrations/index.js";
import { renderReplay, replayExitCode, replayFailure, replayJson, replayMigrations, type OpStepOutcome, type ReplayChange, type ReplayDriver } from "../src/replay/index.js";
import { YodelError } from "../src/project.js";
import { EXIT_FAILED } from "../src/exit.js";

const build = (columns: string, orderBy = "id"): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_11 ENGINE = Atomic", dependsOn: [] },
    { export: "a", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_11.a (${columns}) ENGINE = MergeTree ORDER BY ${orderBy}`, dependsOn: ["db"] },
  ],
});

/** A chain of migrations from successive builds. */
function chain(...builds: BuildOutput[]): Migration[] {
  const out: Migration[] = [];
  builds.forEach((b, i) => {
    const made = createMigration({ name: `m${String(i)}`, build: b, previous: out.at(-1), now: new Date(Date.UTC(2026, 9, 9, 10, i)) });
    if (made.id === undefined) throw new Error("no change");
    out.push({ id: made.id, dir: `/x/${made.id}`, parent: made.document.parent, checksum: made.document.checksum, document: made.document, files: made.files });
  });
  return out;
}

const withSteps = (m: Migration, steps: MigrationStep[]): Migration => ({ ...m, document: { ...m.document, steps } });

interface Fake extends ReplayDriver {
  sent: string[];
  calls: string[];
}

function fake(options: { occupied?: string[]; differs?: Record<string, ReplayChange[]>; failOn?: string; op?: OpStepOutcome } = {}): Fake {
  const sent: string[] = [];
  const calls: string[] = [];
  return {
    dialect: "clickhouse",
    where: "http://emulator:8123 (sql.profiles.ci)",
    scope: ["yodel_11"],
    sent,
    calls,
    occupied: () => Promise.resolve(options.occupied ?? []),
    clear: () => {
      calls.push("clear");
      return Promise.resolve();
    },
    statement: (_m, _i, step) => {
      if (options.failOn && step.sql.includes(options.failOn)) return Promise.reject(new Error("Code: 44. DB::Exception: Cannot add column y: column with this name already exists\nstack"));
      sent.push(step.sql);
      return Promise.resolve();
    },
    opStep: (m, i) => {
      calls.push(`op ${m.id} ${String(i)}`);
      return Promise.resolve(options.op ?? { ran: true, note: "swapped" });
    },
    compare: (m) => {
      calls.push(`compare ${m.id}`);
      return Promise.resolve(options.differs?.[m.id] ?? []);
    },
    close: () => Promise.resolve(),
  };
}

const colChange: ReplayChange = { object: "a (yodel_11.a)", field: "columns.y.type", before: "String", after: "LowCardinality(String)", rule: "column-type", class: "metadata" };

describe("replayMigrations", () => {
  const history = chain(build("id UInt64"), build("id UInt64, y String DEFAULT ''"), build("id UInt64, y String DEFAULT '', z UInt8 DEFAULT 0"));
  const [one, two, three] = history as [Migration, Migration, Migration];

  it("replays every migration in chain order, compares after each, and empties the target at the end", async () => {
    const d = fake();
    const result = await replayMigrations(history, d);
    expect(result.outcome).toBe("matches");
    expect(result.matched.map((m) => m.id)).toEqual(history.map((m) => m.id));
    expect(d.sent.join("\n")).toContain("CREATE DATABASE yodel_11");
    expect(d.sent.at(-1)).toContain("ADD COLUMN z UInt8");
    expect(d.calls).toEqual([`compare ${one.id}`, `compare ${two.id}`, `compare ${three.id}`, "clear"]);
    expect(replayExitCode(result)).toBe(0);
    expect(renderReplay(result)).toContain("Every migration replays to its recorded schema.");
  });

  it("fails at the first migration whose result differs from its recorded schema, naming it and what differs", async () => {
    const d = fake({ differs: { [two.id]: [colChange] } });
    const result = await replayMigrations(history, d);
    expect(result.outcome).toBe("differs");
    expect(replayExitCode(result)).toBe(1);
    // Nothing after the first difference is replayed.
    expect(d.calls).toEqual([`compare ${one.id}`, `compare ${two.id}`, "clear"]);
    const failure = replayFailure(result);
    expect(failure?.migration).toBe(two.id);
    expect(failure?.message).toContain(`${two.id}: replaying the history through it does not give the schema it records (migrations/${two.id}/migration.json); 1 difference:`);
    expect(failure?.message).toContain("a (yodel_11.a): columns.y.type: replay has String, migration.json records LowCardinality(String) (column-type)");
    expect(failure?.message).toContain("The 1 migration before it replayed to its recorded schema.");
    expect(renderReplay(result)).toContain(`  differs ${two.id}`);
    expect(replayJson(result)).toMatchObject({ ok: false, outcome: "differs", migration: { id: two.id }, changes: [colChange] });
  });

  it("reports a statement the server refuses, with its index and the server's first line", async () => {
    const result = await replayMigrations(history, fake({ failOn: "ADD COLUMN y String" }));
    expect(result).toMatchObject({ outcome: "failed", migration: two.id, step: 0, error: "Code: 44. DB::Exception: Cannot add column y: column with this name already exists" });
    expect(replayExitCode(result)).toBe(1);
    expect(replayFailure(result)?.message).toContain(`${two.id}: statement 0 failed in the replay`);
  });

  it("stops at a manual step, which it cannot replay, with exit 3", async () => {
    const manual: MigrationStep = { kind: "manual", object: "a", type: "ClickHouse::Table", name: "yodel_11.a", changes: [], detail: "do it by hand" };
    const result = await replayMigrations([one, withSteps(two, [manual])], fake());
    expect(result).toMatchObject({ outcome: "unreplayable", migration: two.id, step: 0 });
    expect(replayExitCode(result)).toBe(3);
    expect(replayFailure(result)?.message).toContain("a manual step for a (yodel_11.a): no statement and no Op makes it; do it by hand");
  });

  it("runs a rebuild step through the driver and skips a backfill step", async () => {
    const rebuild: MigrationStep = {
      kind: "op",
      object: "a",
      type: "ClickHouse::Table",
      name: "yodel_11.a",
      op: "ClickHouseRebuildOp",
      importPath: "@intentius/chant-lexicon-sql",
      options: { name: "rekey-a", table: "yodel_11.a", dualWrite: { mode: "materialized-view", cutoverColumn: "id" } },
      declaration: "",
      changes: [],
      detail: "",
    };
    const backfill = { kind: "op", object: "backfill", type: "Yodel::Backfill", name: "m1", op: "backfill", importPath: "./backfill.ts", options: { file: "backfill.ts" }, declaration: "", changes: [], detail: "" } as unknown as MigrationStep;
    const d = fake();
    const result = await replayMigrations([one, withSteps(two, [rebuild, backfill])], d);
    expect(result.outcome).toBe("matches");
    expect(d.calls).toContain(`op ${two.id} 0`);
    expect(d.calls).not.toContain(`op ${two.id} 1`);
    expect(result.matched[1]).toMatchObject({ ran: ["step 0: ClickHouseRebuildOp for a (yodel_11.a) (swapped)"], skipped: ["step 1: backfill backfill.ts (moves data; the replayed database has none)"] });
  });

  it("stops where the driver says an Op step cannot be replayed", async () => {
    const op: MigrationStep = {
      kind: "op",
      object: "a",
      type: "ClickHouse::Table",
      name: "yodel_11.a",
      op: "ClickHouseRebuildOp",
      importPath: "@intentius/chant-lexicon-sql",
      options: { name: "rekey-a", table: "yodel_11.a", dualWrite: { mode: "materialized-view", cutoverColumn: "id" } },
      declaration: "",
      changes: [],
      detail: "",
    };
    const result = await replayMigrations([withSteps(one, [op])], fake({ op: { refused: "not yet" } }));
    expect(result).toMatchObject({ outcome: "unreplayable", migration: one.id, step: 0, reason: "not yet" });
  });

  it("refuses a target that is not fresh, running nothing, unless told to reset it", async () => {
    const d = fake({ occupied: ["yodel_11"] });
    const refused = await replayMigrations(history, d).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(YodelError);
    expect((refused as YodelError).exitCode).toBe(EXIT_FAILED);
    expect((refused as YodelError).message).toContain("already holds yodel_11");
    expect(d.sent).toEqual([]);
    expect(d.calls).toEqual([]);

    const reset = await replayMigrations(history, d, { reset: true });
    expect(reset).toMatchObject({ outcome: "matches", reset: true });
    expect(d.calls[0]).toBe("clear");
  });

  it("leaves the replayed database in place with keep", async () => {
    const d = fake({ differs: { [one.id]: [colChange] } });
    const result = await replayMigrations(history, d, { keep: true });
    expect(result.kept).toBe(true);
    expect(d.calls).not.toContain("clear");
    expect(renderReplay(result)).toContain("(left in place)");
  });

  it("has nothing to do for an empty history", async () => {
    const d = fake({ occupied: ["yodel_11"] });
    const result = await replayMigrations([], d);
    expect(result.outcome).toBe("matches");
    expect(d.calls).toEqual([]);
    expect(renderReplay(result)).toContain("No migrations to replay.");
  });
});
