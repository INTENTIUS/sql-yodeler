/**
 * `yodel check` (#1) reads another tool's migrations directory in the order
 * that tool applies it, the up direction only: golang-migrate, goose,
 * Flyway and dbmate, each in its own file syntax.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { splitStatements } from "@intentius/chant-lexicon-sql/postgres/apply/statements";
import { detectTool, readForeign } from "../src/check/readers.js";
import { changedSince } from "../src/commands/check.js";
import { migrationName, onForeignFiles } from "../src/check/run.js";
import type { LintReport } from "../src/lint/index.js";

const split = (sql: string) => splitStatements(sql).map((s) => s.text);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "yodel-check-"));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

const sqls = (d: string, tool: Parameters<typeof readForeign>[1]) => readForeign(d, tool, split).map((m) => ({ file: m.file, statements: m.statements.map((s) => s.sql) }));

describe("golang-migrate", () => {
  it("reads the up files by version, numerically, and leaves the down files", () => {
    const d = dir({
      "1_create.up.sql": "CREATE TABLE users (id bigint);\nCREATE INDEX users_id ON users (id);\n",
      "1_create.down.sql": "DROP TABLE users;\n",
      "10_add_email.up.sql": "ALTER TABLE users ADD COLUMN email text;\n",
      "2_add_name.up.sql": "ALTER TABLE users ADD COLUMN name text;\n",
      "2_add_name.down.sql": "ALTER TABLE users DROP COLUMN name;\n",
    });
    expect(detectTool(d)).toBe("golang-migrate");
    expect(sqls(d, "golang-migrate")).toEqual([
      { file: "1_create.up.sql", statements: ["CREATE TABLE users (id bigint)", "CREATE INDEX users_id ON users (id)"] },
      { file: "2_add_name.up.sql", statements: ["ALTER TABLE users ADD COLUMN name text"] },
      { file: "10_add_email.up.sql", statements: ["ALTER TABLE users ADD COLUMN email text"] },
    ]);
  });
});

describe("goose", () => {
  const create = `-- +goose Up
CREATE TABLE users (id bigint, email text);
-- +goose StatementBegin
CREATE FUNCTION lower_email() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.email := lower(NEW.email);
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

-- +goose Down
DROP TABLE users;
`;

  it("reads the Up section, a StatementBegin block as one statement, and nothing from Down", () => {
    const d = dir({ "20240101120000_create.sql": create, "20240102120000_drop_email.sql": "-- +goose Up\n-- yodel:allow destructive email moved to accounts\nALTER TABLE users DROP COLUMN email;\n\n-- +goose Down\nALTER TABLE users ADD COLUMN email text;\n" });
    expect(detectTool(d)).toBe("goose");
    const read = readForeign(d, "goose", split);
    expect(read.map((m) => m.file)).toEqual(["20240101120000_create.sql", "20240102120000_drop_email.sql"]);
    expect(read[0]?.statements.map((s) => s.sql)).toEqual(["CREATE TABLE users (id bigint, email text)", expect.stringMatching(/^CREATE FUNCTION lower_email\(\)[\s\S]*\$\$$/)]);
    expect(read[0]?.statements.map((s) => s.line)).toEqual([2, 4]);
    expect(read[1]?.statements.map((s) => s.line)).toEqual([3]);
    expect(read[1]?.allows).toEqual([{ rule: "destructive", reason: "email moved to accounts", line: 2 }]);
  });

  it("refuses a Go migration, whose code is not SQL", () => {
    const d = dir({ "20240101120000_create.sql": create, "20240103120000_backfill.go": "package migrations\n" });
    expect(detectTool(d)).toBe("goose");
    expect(() => readForeign(d, "goose", split)).toThrow(/20240103120000_backfill\.go: a Go migration is code/);
  });

  it("refuses a file with no Up section", () => {
    const d = dir({ "20240101120000_create.sql": "CREATE TABLE users (id bigint);\n" });
    expect(() => readForeign(d, "goose", split)).toThrow(/no -- \+goose Up line/);
  });
});

describe("flyway", () => {
  it("reads the versioned files by version, 1.10 after 1.9, then the repeatable ones by description, and no undo file", () => {
    const d = dir({
      "V1__create.sql": "CREATE TABLE users (id bigint);\n",
      "V1.9__add_name.sql": "ALTER TABLE users ADD COLUMN name text;\n",
      "V1.10__add_email.sql": "ALTER TABLE users ADD COLUMN email text;\n",
      "U1.10__add_email.sql": "ALTER TABLE users DROP COLUMN email;\n",
      "R__views.sql": "CREATE OR REPLACE VIEW named AS SELECT id, name FROM users;\n",
      "R__a_first.sql": "CREATE OR REPLACE VIEW ids AS SELECT id FROM users;\n",
    });
    expect(detectTool(d)).toBe("flyway");
    const read = readForeign(d, "flyway", split);
    expect(read.map((m) => m.file)).toEqual(["V1__create.sql", "V1.9__add_name.sql", "V1.10__add_email.sql", "R__a_first.sql", "R__views.sql"]);
    expect(read.filter((m) => m.repeatable).map((m) => m.name)).toEqual(["a_first", "views"]);
  });
});

describe("dbmate", () => {
  it("reads the migrate:up section and nothing from migrate:down", () => {
    const d = dir({
      "20240101120000_create.sql": "-- migrate:up\nCREATE TABLE users (id bigint);\n\n-- migrate:down\nDROP TABLE users;\n",
      "20240102120000_add_email.sql": "-- migrate:up transaction:false\nCREATE INDEX CONCURRENTLY users_id ON users (id);\n\n-- migrate:down\n",
    });
    expect(detectTool(d)).toBe("dbmate");
    expect(sqls(d, "dbmate")).toEqual([
      { file: "20240101120000_create.sql", statements: ["CREATE TABLE users (id bigint)"] },
      { file: "20240102120000_add_email.sql", statements: ["CREATE INDEX CONCURRENTLY users_id ON users (id)"] },
    ]);
  });
});

describe("detectTool", () => {
  it("names none for a directory of plain .sql files", () => {
    expect(detectTool(dir({ "schema.sql": "CREATE TABLE users (id bigint);\n" }))).toBeUndefined();
  });
});

describe("changedSince", () => {
  it("names the files added or changed since the base, and untracked ones, relative to the directory", () => {
    const repo = dir({});
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    mkdirSync(join(repo, "db"));
    writeFileSync(join(repo, "db", "1_create.up.sql"), "CREATE TABLE users (id bigint);\n");
    writeFileSync(join(repo, "db", "R__view.sql"), "SELECT 1;\n");
    git("add", "-A");
    git("-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "base");
    writeFileSync(join(repo, "db", "R__view.sql"), "SELECT 2;\n");
    writeFileSync(join(repo, "db", "2_add.up.sql"), "ALTER TABLE users ADD COLUMN a text;\n");
    expect([...changedSince(join(repo, "db"), "main")].sort()).toEqual(["2_add.up.sql", "R__view.sql"]);
    expect(() => changedSince(join(repo, "db"), "origin/nowhere")).toThrow(/--base origin\/nowhere: no such commit/);
  });
});

describe("migrationName", () => {
  it("makes a name yodel accepts from the other tool's", () => {
    expect(migrationName("Add_Email")).toBe("add-email");
    expect(migrationName("2nd pass")).toBe("m-2nd-pass");
    expect(migrationName("__")).toBe("migration");
  });
});

describe("onForeignFiles", () => {
  const m = (file: string, sql: string[], allows: Array<{ rule: string; reason: string; line: number }> = []) => ({ file, version: "1", name: "x", statements: sql.map((s, i) => ({ sql: s, line: i + 2 })), allows });
  const report = (findings: LintReport["findings"]): LintReport => ({ dir: "/w", dialect: "postgres", environment: undefined, migrations: [], findings, silences: {}, errors: 0, warnings: 0, silenced: 0 });

  it("moves each finding onto the file and line that made it, drops the base's, and applies the file's yodel:allow lines", () => {
    const byId = new Map([
      ["200001010001-drop", m("2_drop.up.sql", ["ALTER TABLE app.users DROP COLUMN nick", "CREATE INDEX CONCURRENTLY users_email ON app.users (email)"], [{ rule: "destructive", reason: "never read", line: 1 }, { rule: "pg-rewrite", reason: "unused", line: 1 }])],
      ["200001010002-add", m("3_add.up.sql", ["ALTER TABLE app.users ADD COLUMN a text NOT NULL"])],
    ]);
    const out = onForeignFiles(
      report([
        { rule: "SQLPG112", level: "warning", message: "in the base", migration: "200001010000-base" },
        { rule: "destructive", level: "error", message: "step 0: drops nick", migration: "200001010001-drop", step: 0, object: "app.users" },
        { rule: "pg-lock", level: "error", message: "step 1: no CONCURRENTLY", migration: "200001010001-drop", step: 1, object: "app.users_email" },
        { rule: "data-dependent", level: "warning", message: "step 0: NOT NULL over NULLs", migration: "200001010002-add", step: 0, object: "app.users" },
      ]),
      byId,
      "/w/db",
    );
    expect(out.findings).toEqual([
      { rule: "destructive", level: "error", message: "drops nick", migration: "2_drop.up.sql", file: "2_drop.up.sql", object: "app.users", line: 2, silenced: "never read" },
      { rule: "data-dependent", level: "warning", message: "NOT NULL over NULLs", migration: "3_add.up.sql", file: "3_add.up.sql", object: "app.users", line: 2 },
      { rule: "silence", level: "warning", migration: "2_drop.up.sql", file: "2_drop.up.sql", line: 1, message: "yodel:allow pg-rewrite silences nothing in 2_drop.up.sql" },
    ]);
    expect([out.errors, out.warnings, out.silenced]).toEqual([0, 2, 1]);
    expect(out.dir).toBe("/w/db");
  });

  it("fails an allow line with no reason", () => {
    const out = onForeignFiles(report([]), new Map([["x", m("1.up.sql", ["SELECT 1"], [{ rule: "destructive", reason: "", line: 1 }])]]), "/w");
    expect(out.findings.map((f) => [f.rule, f.level])).toEqual([["silence", "error"]]);
  });
});
