/**
 * Apply waves through the sql lexicon's capability (#291, chant#4569): with
 * the capability, yodel-waves.json names `step: { kind: "sql-migrate" }` and
 * carries no plan or apply callback; the steps around apply stay out of the
 * spec's apply-stage hooks, so they run once, under the engine's lock, in
 * `--wave-apply`; the op and the wave gates keep the names a 0.10.1 ledger
 * holds. Without the capability, or without chant's product pipeline, the
 * spec keeps the callbacks.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGateLedger } from "@intentius/chant/lifecycle/gate-ledger";
import { applyPipelines, hasSqlCapability, render, SQL_MIGRATE, WAVES_SPEC, wavesSpec, type Wave } from "../src/ci/render.js";
import { PRODUCT } from "./helpers/chant-bin.js";
import { fixture, repoRoot } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const CAPABILITY = await hasSqlCapability();
const { assertOpWavesSpec, opWaveGateName } = (await import("@intentius/chant/op")) as unknown as {
  assertOpWavesSpec: (spec: unknown) => void;
  opWaveGateName: (spec: unknown, k: number) => string;
};

const STEPS = {
  before: [
    { name: "rows", sql: "SELECT 1", expect: { min: 1 } },
    { name: "notify", command: "echo before" },
  ],
  after: [{ name: "vacuum", command: "echo after" }],
};

const WAVES: Wave[] = [
  { env: "dev", gate: "always", steps: STEPS },
  { env: "prod", gate: "on-destructive", requires: "dev" },
];

describe("the waves spec with the sql capability (#291)", () => {
  it("names the capability and carries no plan or apply callback", () => {
    const spec = wavesSpec(WAVES, undefined, undefined, { step: true });
    expect(spec.step).toEqual({ kind: SQL_MIGRATE, environment: "{target}", spec: WAVES_SPEC });
    expect(spec).not.toHaveProperty("plan");
    expect(spec).not.toHaveProperty("apply");
  });

  it("keeps the before.plan SQL checks for chant, and leaves the apply-stage steps to --wave-apply under the lock", () => {
    const hooks = wavesSpec(WAVES, undefined, undefined, { step: true }).waves[0]?.hooks;
    expect(hooks?.before?.plan?.map((h) => h.name)).toEqual(["rows"]);
    expect(hooks?.before?.apply).toBeUndefined();
    expect(hooks?.after).toBeUndefined();
    expect(hooks?.apply).toBeUndefined();
    expect(wavesSpec(WAVES, undefined, undefined, { step: true }).waves[1]?.hooks).toBeUndefined();
  });

  it("without the capability, keeps the callbacks and every stage hook, run by the apply", () => {
    const spec = wavesSpec(WAVES);
    expect(spec.plan).toContain("--wave-plan");
    expect(spec.apply).toContain("--wave-apply");
    expect(spec).not.toHaveProperty("step");
    const hooks = spec.waves[0]?.hooks;
    expect(hooks?.apply).toEqual({ runBy: "apply" });
    expect(hooks?.before?.apply?.map((h) => h.name)).toEqual(["rows", "notify"]);
    expect(hooks?.after?.apply?.map((h) => h.name)).toEqual(["vacuum"]);
  });

  it("is a spec chant accepts, and its gates are the ones a 0.10.1 ledger holds", () => {
    const spec = wavesSpec(WAVES, undefined, undefined, { step: true });
    if (CAPABILITY) expect(() => { assertOpWavesSpec(spec); }).not.toThrow();
    const { pending, resolutions } = parseGateLedger(readFileSync(fixture("ledger-0.10.1/_gates/yodel-apply.jsonl"), "utf8"));
    const recorded = [...new Set([...pending, ...resolutions].map((r) => r.gate))].sort();
    expect(spec.name).toBe("yodel-apply");
    expect(WAVES.map((_, i) => opWaveGateName(spec, i + 1))).toEqual(recorded);
  });
});

/** A copy of the postgres template, resolving chant and the lexicons from this checkout. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-waves-capability-"));
  temps.push(dir);
  cpSync(join(repoRoot, "templates", "postgres"), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("yodel ci and the sql capability (#291)", () => {
  it.skipIf(!PRODUCT || !CAPABILITY)("through chant's product pipeline, writes the capability step into yodel-waves.json", async () => {
    const files = await render(project());
    const spec = JSON.parse(files.find((f) => f.path === WAVES_SPEC)?.content ?? "{}") as Record<string, unknown>;
    expect(spec.step).toEqual({ kind: SQL_MIGRATE, environment: "{target}", spec: WAVES_SPEC });
    expect(spec).not.toHaveProperty("plan");
    expect(spec).not.toHaveProperty("apply");
  });

  it("keeps the callbacks when rendered without chant's product pipeline, as the committed templates are", async () => {
    const dir = project();
    const { environments } = await import("../src/ci/render.js");
    const files = await applyPipelines(dir, await environments(dir));
    const spec = JSON.parse(files.find((f) => f.path === WAVES_SPEC)?.content ?? "{}") as Record<string, unknown>;
    expect(spec).not.toHaveProperty("step");
    expect(spec.plan).toContain("--wave-plan");
  });
});
