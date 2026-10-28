/**
 * The edits a harness scenario's project gets (scenarios/harness/seed.ts and
 * overlays.ts), on the starter templates' own files. Nothing here runs
 * chant init, npm or a forge.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupOf } from "../scenarios/harness/catalog.js";
import { editColumn, setGate } from "../scenarios/harness/overlays.js";
import { configFor, envOfGate, forgeAccess, person, remoteAs } from "../scenarios/harness/seed.js";
import { repoRoot } from "../scenarios/lib/project.js";

const template = (dialect: string, file: string) => readFileSync(join(repoRoot, "templates", dialect, file), "utf8");

describe("the project's yodel.config.ts", () => {
  const config = template("clickhouse", "yodel.config.ts");

  it("keeps dev alone for sy-forge, with the project's job", () => {
    const out = configFor(config, setupOf("sy-forge-clickhouse"), undefined);
    expect(out).not.toMatch(/prod/);
    expect(out).toContain('{ env: "dev", gate: "always" }');
    expect(out).toContain('jobs: "ci/jobs.ts"');
  });

  it("keeps both waves for sy-waves, and renders them with gate: never under its BREAK", () => {
    expect(configFor(config, setupOf("sy-waves-postgres"), undefined)).toContain('{ env: "prod", gate: "always" }');
    const broken = configFor(config, setupOf("sy-waves-postgres"), "gate-never");
    expect(broken).toContain('{ env: "dev", gate: "never" }');
    expect(broken).toContain('{ env: "prod", gate: "never" }');
  });

  it("adds approval's policy at the base: no-drops in dev, overridable by the harness", () => {
    const out = configFor(template("postgres", "yodel.config.ts"), setupOf("sy-approval-postgres"), undefined);
    expect(out).toContain('rules: [{ id: "no-drops", environments: ["dev"], refuse: { classes: ["drop"] } }]');
    expect(out).toContain('overriders: ["yodel-harness"]');
  });
});

describe("the overlays' edits", () => {
  it.each([
    ["clickhouse", "ch", "String DEFAULT ''"],
    ["postgres", "pg", "text"],
  ] as const)("add and drop a column on the %s template's table, the last one or one before another", (dir, dialect, type) => {
    const schema = template(dir, "src/schema.ts");
    const note = editColumn(schema, dialect, "note", "add");
    expect(note).toContain(`,\n    note ${type}\n  )`);
    const both = editColumn(note, dialect, "audit", "add");
    expect(both).toContain(`    note ${type},\n    audit ${type}\n  )`);
    expect(editColumn(both, dialect, "note", "drop")).toBe(editColumn(schema, dialect, "audit", "add"));
    expect(editColumn(note, dialect, "note", "drop")).toBe(schema);
    expect(() => editColumn(schema, dialect, "note", "drop")).toThrow(/no note column/);
  });

  it("sets one wave's gate", () => {
    const config = template("clickhouse", "yodel.config.ts");
    expect(setGate(config, "dev", "never")).toContain('{ env: "dev", gate: "never" }');
    expect(setGate(config, "dev", "never")).toContain('{ env: "prod", gate: "always" }');
    expect(() => setGate(config, "staging", "never")).toThrow(/no wave for staging/);
  });
});

describe("the forge access", () => {
  it("reads the three people and the repository", () => {
    const a = forgeAccess({ YODEL_HARNESS_ADMIN: "root:t0", YODEL_HARNESS_AUTHOR: "ana:t1", YODEL_HARNESS_REVIEWER: "rui:t2" }, "sy-forge-postgres", "http://localhost:3391/");
    expect(a).toEqual({ url: "http://localhost:3391", repo: "yodel-harness/yodel-sy-forge-postgres", admin: { login: "root", token: "t0" }, author: { login: "ana", token: "t1" }, reviewer: { login: "rui", token: "t2" } });
    expect(remoteAs(a, a.author)).toBe("http://ana:t1@localhost:3391/yodel-harness/yodel-sy-forge-postgres.git");
    expect(() => person("no-token", "YODEL_HARNESS_ADMIN")).toThrow(/YODEL_HARNESS_ADMIN is not set as <login>:<token>/);
  });

  it("names the environment of a wave's gate", () => {
    expect(envOfGate("yodel-apply-wave-2", ["dev", "prod"])).toBe("prod");
    expect(() => envOfGate("yodel-apply-wave-3", ["dev", "prod"])).toThrow(/not a wave gate/);
  });
});
