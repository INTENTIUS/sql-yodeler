/**
 * Checkpoints (#63): what yodel checkpoint writes, how an environment's
 * status treats one (a fresh history starts there, an existing one skips
 * it), the lint rule that ties it to its parent's recorded schema, and the
 * replay of it on its own.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildOutput } from "../src/chant/build.js";
import { deriveState, type HistoryRow } from "../src/history/index.js";
import { lintMigrations } from "../src/lint/index.js";
import { checkpointProblems, computeChecksum, createCheckpoint, createMigration, isCheckpoint, readMigrations, schemaSha, serializeDocument, writeMigration, type Migration } from "../src/migrations/index.js";
import { replayMigrations, type ReplayDriver } from "../src/replay/index.js";
import { compareHistory, outOfOrder, statusJson } from "../src/versioned/index.js";

const build = (columns: string): BuildOutput => ({
  dialect: "clickhouse",
  objects: [
    { export: "db", type: "ClickHouse::Database", ddl: "CREATE DATABASE yodel_63 ENGINE = Atomic", dependsOn: [] },
    { export: "a", type: "ClickHouse::Table", ddl: `CREATE TABLE yodel_63.a (${columns}) ENGINE = MergeTree ORDER BY id`, dependsOn: ["db"] },
  ],
});

const asMigration = (made: { id: string; document: Migration["document"]; files: Migration["files"] }): Migration => ({
  id: made.id,
  dir: `/x/${made.id}`,
  parent: made.document.parent,
  checksum: made.document.checksum,
  document: made.document,
  files: made.files,
});

/** Two migrations, a checkpoint after them, and one more after it. */
function history(): { m0: Migration; m1: Migration; cp: Migration; m2: Migration } {
  const at = (i: number) => new Date(Date.UTC(2026, 9, 10, 9, i));
  const make = (name: string, b: BuildOutput, previous: Migration | undefined, i: number) => {
    const made = createMigration({ name, build: b, previous, now: at(i) });
    if (made.id === undefined) throw new Error("no change");
    return asMigration(made);
  };
  const m0 = make("create", build("id UInt64"), undefined, 0);
  const m1 = make("add-note", build("id UInt64, note String"), m0, 1);
  const cp = asMigration(createCheckpoint({ name: "base", parent: m1, now: at(2) }));
  const m2 = make("add-kind", build("id UInt64, note String, kind String"), cp, 3);
  return { m0, m1, cp, m2 };
}

const row = (seq: number, id: string, parent: string | null, checksum: string, status: HistoryRow["status"] = "succeeded"): HistoryRow => ({
  seq,
  run_id: "r",
  kind: "migration",
  migration_id: id,
  parent: parent ?? "",
  checksum,
  statement_index: -1,
  statement_sha: "",
  status,
  error: "",
  applied_by: "t",
  plan_digest: "",
  silences: "[]",
  note: "",
});

describe("yodel checkpoint: the migration it writes", () => {
  it("follows the newest migration, records its schema, and creates it from nothing", () => {
    const { m1, cp } = history();
    expect(isCheckpoint(cp)).toBe(true);
    expect(isCheckpoint(m1)).toBe(false);
    expect(cp.parent).toBe(m1.id);
    expect(cp.document.schema).toEqual(m1.document.schema);
    expect(cp.document.checkpoint).toEqual({ schema: schemaSha(m1.document.schema) });
    const sql = cp.document.steps.map((s) => (s.kind === "statement" ? s.sql : ""));
    expect(sql.some((s) => /CREATE DATABASE/.test(s))).toBe(true);
    expect(sql.some((s) => /CREATE TABLE/.test(s) && s.includes("note"))).toBe(true);
    expect(cp.files.sql).toMatch(/^-- yodel checkpoint /);
    expect(computeChecksum(cp.files)).toBe(cp.checksum);
  });

  it("is written to disk and read back as one chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-63-"));
    try {
      const { m0, m1, cp, m2 } = history();
      for (const m of [m0, m1, cp, m2]) writeMigration(dir, m);
      expect(readMigrations(dir, { verify: true }).map((m) => m.id)).toEqual([m0.id, m1.id, cp.id, m2.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a parent whose recorded schema declares nothing", () => {
    const { m0 } = history();
    const empty = { ...m0, document: { ...m0.document, schema: { dialect: "clickhouse" as const, objects: [] } } };
    expect(() => createCheckpoint({ name: "base", parent: empty })).toThrow(/declares nothing/);
  });
});

describe("status with a checkpoint", () => {
  it("starts an empty history at the newest checkpoint: the migrations before it are skipped", () => {
    const { m0, m1, cp, m2 } = history();
    const s = compareHistory([m0, m1, cp, m2], deriveState([]));
    expect(s.pending.map((p) => p.id)).toEqual([cp.id, m2.id]);
    expect(s.skipped).toEqual([
      { id: m0.id, reason: "covered", checkpoint: cp.id },
      { id: m1.id, reason: "covered", checkpoint: cp.id },
    ]);
    expect(statusJson({ environment: "e", location: { database: "h", topology: { kind: "single" } }, status: s }).skipped).toEqual(s.skipped);
  });

  it("keeps skipping them once the checkpoint is applied, and never calls them out of order", () => {
    const { m0, m1, cp, m2 } = history();
    const s = compareHistory([m0, m1, cp, m2], deriveState([row(1, cp.id, m1.id, cp.checksum)]));
    expect(s.applied.map((a) => a.id)).toEqual([cp.id]);
    expect(s.pending.map((p) => p.id)).toEqual([m2.id]);
    expect(outOfOrder(s)).toEqual([]);
    expect(s.skipped?.map((k) => k.id)).toEqual([m0.id, m1.id]);
  });

  it("skips the checkpoint in an environment that ran the chain", () => {
    const { m0, m1, cp, m2 } = history();
    const s = compareHistory([m0, m1, cp, m2], deriveState([row(1, m0.id, null, m0.checksum), row(2, m1.id, m0.id, m1.checksum)]));
    expect(s.pending.map((p) => p.id)).toEqual([m2.id]);
    expect(s.skipped).toEqual([{ id: cp.id, reason: "checkpoint" }]);
    expect(outOfOrder(s)).toEqual([]);
  });

  it("skips it too where the environment ran only part of the chain, which goes on past it", () => {
    const { m0, m1, cp, m2 } = history();
    const s = compareHistory([m0, m1, cp, m2], deriveState([row(1, m0.id, null, m0.checksum)]));
    expect(s.pending.map((p) => p.id)).toEqual([m1.id, m2.id]);
    expect(s.skipped).toEqual([{ id: cp.id, reason: "checkpoint" }]);
  });

  it("leaves a chain with no checkpoint as it was", () => {
    const { m0, m1 } = history();
    const s = compareHistory([m0, m1], deriveState([]));
    expect(s.pending.map((p) => p.id)).toEqual([m0.id, m1.id]);
    expect(s.skipped).toBeUndefined();
  });
});

describe("lint rule checkpoint", () => {
  it("passes a checkpoint as written, and fails one whose recorded schema is not its parent's", () => {
    const { m0, m1, cp } = history();
    const byId = new Map([m0, m1, cp].map((m) => [m.id, m]));
    expect(checkpointProblems(cp, byId)).toEqual([]);
    expect(checkpointProblems(m1, byId)).toEqual([]);
    const other = { ...cp, document: { ...cp.document, schema: m0.document.schema } };
    expect(checkpointProblems(other, byId).join("\n")).toMatch(/edited after yodel checkpoint wrote it/);
    const moved = new Map(byId).set(m1.id, { ...m1, document: { ...m1.document, schema: m0.document.schema } });
    expect(checkpointProblems(cp, moved).join("\n")).toMatch(/its parent .* now hashes to/);
  });

  it("is an error in yodel lint, even with the checksum recomputed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-63-"));
    try {
      const { m0, m1, cp } = history();
      const document = { ...cp.document, schema: m0.document.schema };
      const signed = { ...document, checksum: computeChecksum({ sql: cp.files.sql, json: document }) };
      for (const m of [m0, m1, { ...cp, document: signed, files: { sql: cp.files.sql, json: serializeDocument(signed) } }]) writeMigration(dir, m);
      const report = await lintMigrations(dir, { dialect: "clickhouse" });
      expect(report.findings.filter((f) => f.rule === "checkpoint").map((f) => f.level)).toEqual(["error"]);
      expect(report.findings.some((f) => f.rule === "checksum")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("replay with a checkpoint", () => {
  it("replays the chain without it, then the checkpoint alone into an emptied database", async () => {
    const { m0, m1, cp, m2 } = history();
    const calls: string[] = [];
    const driver: ReplayDriver = {
      dialect: "clickhouse",
      where: "fake",
      scope: ["yodel_63"],
      occupied: () => Promise.resolve([]),
      clear: () => {
        calls.push("clear");
        return Promise.resolve();
      },
      statement: (m, i) => {
        calls.push(`${m.id} ${String(i)}`);
        return Promise.resolve();
      },
      opStep: () => Promise.resolve({ ran: true }),
      compare: (m) => {
        calls.push(`compare ${m.id}`);
        return Promise.resolve([]);
      },
      close: () => Promise.resolve(),
    };
    const result = await replayMigrations([m0, m1, cp, m2], driver);
    expect(result.outcome).toBe("matches");
    expect(result.matched.map((m) => [m.id, m.checkpoint ?? false])).toEqual([
      [m0.id, false],
      [m1.id, false],
      [m2.id, false],
      [cp.id, true],
    ]);
    const cpAt = calls.indexOf(`${cp.id} 0`);
    expect(calls.indexOf(`compare ${m2.id}`)).toBeLessThan(cpAt);
    expect(calls[cpAt - 1]).toBe("clear");
  });
});
