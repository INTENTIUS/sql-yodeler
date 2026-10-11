/**
 * yodel create and yodel emulator (#202): the commands that make a project
 * and run the local database, with chant underneath. chant is not run here:
 * each test hands the command a runner that records what it was asked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Io } from "../src/command.js";
import type { ChantResult, RunChantOptions } from "../src/chant/process.js";
import { chantInitArgs, createCommand, parseCreateArgs, templateSource } from "../src/commands/create.js";
import { emulatorCommand } from "../src/commands/emulator.js";
import { version } from "../src/version.js";
import { fixture } from "./helpers/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "yodel-create-"));
  dirs.push(d);
  return d;
}

/** A runner that records each call and answers with `result`, writing `stdout` through the caller's callback. */
function recorder(result: Partial<ChantResult> = {}) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = (args: readonly string[], options: RunChantOptions): Promise<ChantResult> => {
    calls.push({ args: [...args], cwd: options.cwd });
    if (result.stdout) options.onStdout?.(result.stdout);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...result });
  };
  return { run, calls };
}

const capture = () => {
  let out = "";
  let err = "";
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  return { io, out: () => out, err: () => err };
};

describe("yodel create", () => {
  it("copies the template released with this yodel, with the dialect's parameters", () => {
    const v = version();
    expect(chantInitArgs(parseCreateArgs(["my-schema", "--clickhouse", "--database", "events"]))).toEqual([
      "init", "--from", `INTENTIUS/sql-yodeler@v${v}#templates/clickhouse`, "--param", "name=my-schema", "--param", "database=events", "my-schema",
    ]);
    expect(chantInitArgs(parseCreateArgs(["apps/my-schema", "--postgres", "--schema", "app", "--name", "app-schema"]))).toEqual([
      "init", "--from", `INTENTIUS/sql-yodeler@v${v}#templates/postgres`, "--param", "name=app-schema", "--param", "schema=app", "apps/my-schema",
    ]);
    expect(chantInitArgs(parseCreateArgs(["s", "--clickhouse", "--history", "ops"]))).toContain("history_database=ops");
    expect(chantInitArgs(parseCreateArgs(["s", "--postgres", "--history", "ops"]))).toContain("history_schema=ops");
    // The template's own defaults hold for what is not given.
    expect(chantInitArgs(parseCreateArgs(["s", "--postgres"]))).toEqual(["init", "--from", `INTENTIUS/sql-yodeler@v${v}#templates/postgres`, "--param", "name=s", "s"]);
  });

  it("takes --from, for developing yodel, adding the dialect's member unless it names one", () => {
    expect(templateSource("clickhouse", undefined, "1.2.3")).toBe("INTENTIUS/sql-yodeler@v1.2.3#templates/clickhouse");
    expect(templateSource("clickhouse", "/src/sql-yodeler")).toBe("/src/sql-yodeler#templates/clickhouse");
    expect(templateSource("postgres", "INTENTIUS/sql-yodeler@main")).toBe("INTENTIUS/sql-yodeler@main#templates/postgres");
    expect(templateSource("postgres", "/src/t#custom")).toBe("/src/t#custom");
  });

  it.each([
    [["my-schema"], "--clickhouse or --postgres: name the dialect"],
    [["my-schema", "--clickhouse", "--postgres"], "--clickhouse and --postgres: pick one dialect"],
    [["--clickhouse"], "name the directory to make the project in"],
    [["a", "b", "--clickhouse"], "one directory, got 2: a b"],
    [["s", "--clickhouse", "--schema", "app"], "--schema is for a Postgres project; a ClickHouse project takes --database"],
    [["s", "--postgres", "--database", "app"], "--database is for a ClickHouse project; a Postgres project takes --schema"],
    [["My_Schema", "--postgres"], "the directory's name, My_Schema, is not a package name"],
    [["s", "--postgres", "--name", "Bad Name"], "--name Bad Name is not a package name"],
    [["s", "--postgres", "--yes"], "Unknown option '--yes'"],
  ])("refuses %j, naming the flag (exit 1, chant not run)", async (args, message) => {
    const r = recorder();
    const c = capture();
    expect(await createCommand(r.run).run(args, c.io)).toBe(1);
    expect(c.err()).toContain(message);
    expect(r.calls).toEqual([]);
  });

  it("refuses a directory that exists and is not empty, and takes an empty one", async () => {
    const root = temp();
    const full = join(root, "full");
    mkdirSync(full);
    writeFileSync(join(full, "README.md"), "mine\n");
    const r = recorder();
    const c = capture();
    expect(await createCommand(r.run).run([full, "--clickhouse", "--name", "full"], c.io)).toBe(1);
    expect(c.err()).toContain(`refused: ${full} exists and is not empty (1 entry)`);
    expect(r.calls).toEqual([]);
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(await createCommand(r.run).run([empty, "--clickhouse"], capture().io)).toBe(0);
    // A fresh clone of an empty repository holds only .git.
    const clone = join(root, "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    expect(await createCommand(r.run).run([clone, "--postgres"], capture().io)).toBe(0);
    expect(r.calls).toHaveLength(2);
  });

  it("prints chant's output, then the next steps", async () => {
    const root = temp();
    const r = recorder({ stdout: "Created:\n  package.json\n" });
    const c = capture();
    expect(await createCommand(r.run).run([join(root, "events-schema"), "--clickhouse", "--database", "events"], c.io)).toBe(0);
    expect(c.out()).toContain("Created:\n  package.json\n");
    expect(c.out()).toContain("npm install");
    expect(c.out()).toContain("npx yodel emulator up");
    expect(c.out()).toContain("https://intentius.io/sql-yodeler/getting-started/");
  });

  it("fails when chant cannot copy the template, and prints no next steps", async () => {
    const r = recorder({ code: 1 });
    const c = capture();
    expect(await createCommand(r.run).run([join(temp(), "s"), "--postgres"], c.io)).toBe(1);
    expect(c.err()).toContain(`chant init --from INTENTIUS/sql-yodeler@v${version()}#templates/postgres failed (exit 1`);
    expect(c.out()).not.toContain("Next:");
  });
});

describe("yodel emulator", () => {
  it("runs chant's emulator for the sql lexicon in the project, passing --port and --json through", async () => {
    const dir = fixture("clickhouse");
    const r = recorder();
    const cmd = emulatorCommand(r.run);
    expect(await cmd.run(["up", "--dir", dir], capture().io)).toBe(0);
    expect(await cmd.run(["up", "--port", "8123=18123", "--port", "5432=15432", "--json", "-C", dir], capture().io)).toBe(0);
    expect(await cmd.run(["status", "--json", "--dir", dir], capture().io)).toBe(0);
    expect(await cmd.run(["down", "--dir", dir], capture().io)).toBe(0);
    expect(r.calls).toEqual([
      { args: ["emulator", "up", "--lexicon", "sql"], cwd: dir },
      { args: ["emulator", "up", "--lexicon", "sql", "--port", "8123=18123", "--port", "5432=15432", "--json"], cwd: dir },
      { args: ["emulator", "status", "--lexicon", "sql", "--json"], cwd: dir },
      { args: ["emulator", "down", "--lexicon", "sql"], cwd: dir },
    ]);
  });

  it("exits with chant's code and prints chant's report", async () => {
    const r = recorder({ code: 1, stdout: "sql: chant-clickhouse is not running\n" });
    const c = capture();
    expect(await emulatorCommand(r.run).run(["status", "--dir", fixture("clickhouse")], c.io)).toBe(1);
    expect(c.out()).toBe("sql: chant-clickhouse is not running\n");
    expect(await emulatorCommand(recorder({ code: 3 }).run).run(["up", "--dir", join(fixture("clickhouse"), "src")], capture().io)).toBe(3);
  });

  it.each([
    [[], "name what to do"],
    [["start"], "unknown start: up, down or status"],
    [["up", "down"], "one of up, down or status, got up down"],
    [["down", "--port", "8123=1"], "--port is for yodel emulator up"],
    [["up", "--lexicon", "sql"], "Unknown option '--lexicon'"],
  ])("refuses %j (exit 1, chant not run)", async (args, message) => {
    const r = recorder();
    const c = capture();
    expect(await emulatorCommand(r.run).run(args, c.io)).toBe(1);
    expect(c.err()).toContain(message);
    expect(r.calls).toEqual([]);
  });
});
