import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findProjectDir, loadProject, projectFromConfig, resolveEnvironment, YodelError } from "../src/project.js";
import { fixture } from "./helpers/run.js";

describe("loadProject", () => {
  it("loads a fixture's chant.config.ts through chant, from the project or a directory inside it", async () => {
    for (const start of [fixture("clickhouse"), join(fixture("clickhouse"), "src")]) {
      const project = await loadProject(start);
      expect(project.dir).toBe(fixture("clickhouse"));
      expect(project.dialect).toBe("clickhouse");
      expect(project.sourceDir).toBe("src");
      expect(Object.keys(project.config.sql?.profiles ?? {})).toEqual(["e2e"]);
    }
    expect((await loadProject(fixture("postgres"))).dialect).toBe("postgres");
  });

  it("fails outside a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-none-"));
    try {
      expect(findProjectDir(dir)).toBeUndefined();
      await expect(loadProject(dir)).rejects.toThrow(/no chant.config.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projectFromConfig", () => {
  const make = (config: Record<string, unknown>) => projectFromConfig("/p", "/p/chant.config.ts", config);

  it("defaults the dialect to clickhouse, as chant does", () => {
    expect(make({ lexicons: ["sql"] }).dialect).toBe("clickhouse");
    expect(make({ lexicons: ["sql"], sql: { dialect: ["postgres"] } }).dialect).toBe("postgres");
  });

  it("refuses a config without the sql lexicon, or with two dialects", () => {
    expect(() => make({ lexicons: ["aws"] })).toThrow(/does not include "sql"/);
    expect(() => make({ lexicons: ["sql"], sql: { dialect: ["clickhouse", "postgres"] } })).toThrow(YodelError);
  });
});

describe("resolveEnvironment", () => {
  const project = projectFromConfig("/p", "/p/chant.config.ts", {
    lexicons: ["sql"],
    sql: { dialect: "clickhouse", profiles: { dev: { url: "http://ch:8123" }, odd: { url: "postgres://pg/db" } } },
  });

  it("returns sql.profiles.<env>", () => {
    expect(resolveEnvironment(project, "dev")).toEqual({ name: "dev", profile: { url: "http://ch:8123" } });
  });

  it("names the declared environments when the one asked for is not", () => {
    expect(() => resolveEnvironment(project, "prod")).toThrow(/no environment "prod".*declared: dev, odd/);
  });

  it("refuses a profile of the other dialect", () => {
    expect(() => resolveEnvironment(project, "odd")).toThrow(/Postgres server, but the project's dialect is clickhouse/);
  });
});
