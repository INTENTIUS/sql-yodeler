import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { Io } from "../src/command.js";
import { installedLocally, onPath, runnable } from "../src/chant/runnable.js";
import { renderPlanText } from "../src/pr/render.js";
import type { VersionedPlan } from "../src/pr/model.js";
import { fixture } from "./helpers/run.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project directory with `node_modules/.bin/<tools>`, and a PATH directory with `<global>`. */
function layout(tools: string[], global: string[] = []): { project: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "yodel-runnable-"));
  dirs.push(root);
  const bin = join(root, "project", "node_modules", ".bin");
  const path = join(root, "global");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path);
  for (const [dir, names] of [[bin, tools], [path, global]] as const) {
    for (const t of names) {
      writeFileSync(join(dir, t), "#!/bin/sh\n");
      chmodSync(join(dir, t), 0o755);
    }
  }
  return { project: join(root, "project"), path };
}

describe("the approve command yodel prints runs as printed (#14)", () => {
  it("is npx chant ... when chant is installed in the project but not on PATH", () => {
    const { project, path } = layout(["chant", "yodel"]);
    const env = { PATH: path };
    expect(installedLocally("chant", join(project, "sub"))).toBe(true);
    expect(runnable("chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00", project, env)).toBe("npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00");
    expect(runnable("yodel apply dev", project, env)).toBe("npx yodel apply dev");
  });

  it("counts npx's node_modules/.bin on yodel's own PATH as not on the person's", () => {
    const { project, path } = layout(["chant"]);
    const env = { PATH: [join(project, "node_modules", ".bin"), path].join(":") };
    expect(onPath("chant", env)).toBe(false);
    expect(runnable("chant approve a b --plan d", project, env)).toBe("npx chant approve a b --plan d");
  });

  it("is left as it is when chant is on PATH, or not installed in the project", () => {
    const onBoth = layout(["chant"], ["chant"]);
    expect(runnable("chant approve a b --plan d", onBoth.project, { PATH: onBoth.path })).toBe("chant approve a b --plan d");
    const nowhere = layout([]);
    expect(runnable("chant approve a b --plan d", nowhere.project, { PATH: nowhere.path })).toBe("chant approve a b --plan d");
  });

  it("plan's text names yodel approve next to the chant approve command", () => {
    const plan: VersionedPlan = {
      environment: "dev",
      dialect: "clickhouse",
      appliedCount: 0,
      pending: [],
      problems: [],
      notes: [],
      digest: "jcs1-sha256:00",
      approval: { kind: "op", op: "migrate-dev", gate: "approve-migrate-dev", command: "chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00" },
    };
    const text = renderPlanText(plan, { runnable: (c) => `npx ${c}` });
    expect(text).toContain("Approve it with:\n  npx chant approve migrate-dev approve-migrate-dev --plan jcs1-sha256:00\nor, at a terminal, with npx yodel approve dev, which shows the plan and asks you first.");
  });
});

describe("yodel approve", () => {
  const capture = (ask?: Io["ask"]) => {
    let out = "";
    let err = "";
    const io: Io = { out: (t) => (out += t), err: (t) => (err += t), ...(ask ? { ask } : {}) };
    return { io, text: () => ({ out, err }) };
  };

  it("approves nothing without a terminal to ask, before reading the server, and has no flag that skips the question", async () => {
    const c = capture();
    const code = await main(["approve", "e2e", "--dir", fixture("lint-clickhouse")], c.io);
    expect(code).toBe(4);
    expect(c.text().err).toContain("there is no terminal to ask, so nothing was approved");
    const forced = capture();
    expect(await main(["approve", "e2e", "--yes", "--dir", fixture("lint-clickhouse")], forced.io)).toBe(1);
    expect(forced.text().err).toContain("Unknown option '--yes'");
  });

  it("is for versioned projects", async () => {
    const c = capture(() => Promise.resolve("e2e"));
    const code = await main(["approve", "e2e", "--dir", fixture("clickhouse")], c.io);
    expect(code).toBe(1);
    expect(c.text().err).toMatch(/yodel approve is for versioned migrations/);
  });
});
