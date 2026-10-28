import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { describePath, renderDrift } from "../src/chant/drift.js";
import { discoveryError } from "../src/chant/apply.js";
import { onlySilencesAdded } from "../src/lint/check.js";
import { explainMove } from "../src/versioned/explain.js";
import { readMigrations, type Migration } from "../src/migrations/index.js";
import type { YodelConfig } from "../src/config/index.js";
import { json, projectFrom, yodel } from "./helpers/run.js";
import { migration } from "./helpers/fake-clickhouse.js";

describe("CLI polish (#19)", () => {
  it("drift names a column by its declared name, not its position", () => {
    expect(describePath("columns[3].default.expr", ["id", "ts", "kind", "country"])).toBe("column country default.expr");
    expect(describePath("columns[3]", ["id", "ts", "kind", "country"])).toBe("column country");
    expect(describePath("columns[9].type", ["id"])).toBe("columns[9].type");
    expect(describePath("engine", undefined)).toBe("engine");
    const text = renderDrift({
      environment: "dev",
      changed: [{ name: "events", type: "ClickHouse::Table", changes: [{ path: "columns[1].default.expr", kind: "changed", declared: "", live: "US" }] }] as never,
      missing: [],
      unobserved: [],
      columns: { events: ["id", "country"] },
    });
    expect(text).toContain("    column country default.expr: declared , live US");
  });

  it("says why Ops need git, and what to run", () => {
    expect(discoveryError("/p", new Error("Not in a git repository")).message).toBe(
      "yodel apply finds the project's Ops through git, and /p is not in a git repository: run git init, then commit the project (git add -A && git commit -m init)",
    );
    expect(discoveryError("/p", new Error("boom")).message).toBe("could not discover Ops in /p: boom");
  });

  it("types lint.rules in yodel.config.ts, so a misspelled rule does not type-check", () => {
    const ok: YodelConfig = { lint: { rules: { destructive: "warning", replay: "off" } } };
    // @ts-expect-error: no rule is named destructiv
    const bad: YodelConfig = { lint: { rules: { destructiv: "warning" } } };
    expect([ok, bad]).toHaveLength(2);
  });

  it("tells a checksum change that is only added yodel:allow lines", () => {
    const m = migration("20261009T1000-one", null, ["ALTER TABLE t DROP COLUMN c"]);
    const silenced: Migration = { ...m, files: { ...m.files, sql: `-- yodel:allow destructive the column is unused\n${m.files.sql}` } };
    expect(onlySilencesAdded(silenced, m.checksum)).toBe(true);
    const edited: Migration = { ...silenced, files: { ...silenced.files, sql: `${silenced.files.sql}\nSELECT 1;\n` } };
    expect(onlySilencesAdded(edited, m.checksum)).toBe(false);
    expect(onlySilencesAdded(m, m.checksum)).toBe(false);
  });

  it("says the live schema moved as expected when migrations were applied since approval", async () => {
    const m1 = migration("20261009T1000-one", null, ["CREATE DATABASE d"]);
    const row = (seq: number, at: string) => ({
      seq, run_id: "r", kind: "migration", migration_id: m1.id, parent: "", checksum: m1.checksum, statement_index: -1, statement_sha: "", status: "succeeded",
      error: "", applied_by: "alice", plan_digest: "", silences: "[]", note: "", recorded_at: at,
    });
    const now = { environment: "dev", historyDatabase: "h", applied: [{ id: m1.id, checksum: m1.checksum }], pending: [], live: "sha256:after" } as never;
    const moved = await explainMove({ approvedDigest: "jcs1-sha256:00", approvedAt: "2026-10-09T10:00:00.000Z", now, ordered: [m1], rows: [row(1, "2026-10-09T11:00:00.000Z")] as never, budget: 50 });
    const live = moved.changes.find((c) => c.part === "live");
    expect(moved.changes.some((c) => c.part === "history")).toBe(true);
    expect(live?.message).toMatch(/^as expected after the history change above/);
  });
});

describe("yodel repair takes the environment first too (#19)", () => {
  it("reads <env> <id> and <id> ... <env> the same way", async () => {
    // Both orders reach the same check: the migration is not in this project.
    const a = await yodel(["repair", "e2e", "20261009T1000-nope", "--reason", "x", "--dir", "/nonexistent-yodel"]);
    const b = await yodel(["repair", "20261009T1000-nope", "--reason", "x", "e2e", "--dir", "/nonexistent-yodel"]);
    expect(a.err.replace(/^yodel repair: /, "")).toBe(b.err.replace(/^yodel repair: /, ""));
    expect(a.err).not.toContain("usage:");
  });
});

describe("yodel new --replace (#19)", () => {
  const project = projectFrom("clickhouse");
  const dir = project.dir;
  const migrations = join(dir, "migrations");
  afterAll(() => { project.dispose(); });
  const schema = join(dir, "src", "schema.ts");

  it("redoes the newest migration from its parent, under its name only", async () => {
    const none = await yodel(["new", "create", "--replace", "--dir", dir]);
    expect(none.code).toBe(1);
    expect(none.err.trim()).toBe("yodel new: --replace redoes the newest migration, and there is none yet; run yodel new create");
    expect((await yodel(["new", "create", "--dir", dir])).code).toBe(0);
    writeFileSync(schema, readFileSync(schema, "utf8").replace("    ts   DateTime\n", "    ts   DateTime,\n    note String DEFAULT ''\n"));
    expect((await yodel(["new", "add-note", "--dir", dir])).code).toBe(0);
    const before = readMigrations(migrations);
    writeFileSync(schema, readFileSync(schema, "utf8").replace("    note String DEFAULT ''\n", "    note String DEFAULT 'x'\n"));

    const wrong = await yodel(["new", "other", "--replace", "--dir", dir]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("which is not named other");
    // The refusal is the one line, not --check's help (#119).
    expect(wrong.err).not.toContain("--check");
    expect(wrong.err.trim().split("\n")).toHaveLength(1);

    const ran = await yodel(["new", "add-note", "--replace", "--json", "--dir", dir]);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.err).toContain("--replace checked no environment");
    const after = readMigrations(migrations);
    expect(after).toHaveLength(2);
    expect(after[1]?.parent).toBe(before[0]?.id);
    expect(after[1]?.files.sql).toContain("DEFAULT 'x'");
    expect((json(ran) as { parent: string }).parent).toBe(before[0]?.id);
    expect(readdirSync(migrations).filter((d) => d.startsWith("."))).toEqual([]);
  });
});
