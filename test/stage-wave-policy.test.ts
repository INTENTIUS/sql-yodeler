/**
 * The engine's end of a promote into a later stage (#384). `chant components
 * promote` writes the stage's spec to `.chant/op-waves/<pipeline>-<stage>.spec.json`,
 * which no commit holds, and hands that file to the `sql-migrate` step. yodel
 * reads each wave's gate for it from `.chant/pipeline.ts` at the default
 * branch's commit (chant's `promoteBase` and `pipelineStageShow`), so the file
 * on disk cannot loosen a gate. Run in a temp repo with no remote: the default
 * branch's commit is HEAD.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { foldPipelineSource, stageRunSpec } from "@intentius/chant/pipeline";
import { forecastWave } from "../src/waves/index.js";

const PIPELINE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "yodel-apply",
  defaults: { op: "yodel-apply", step: { kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" } },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }], gate: "never" }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }], gate: "always" }], gate: { policy: "never" } },
  ],
});
`;

const dir = mkdtempSync(join(tmpdir(), "yodel-stage-policy-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();

git("init", "-q", "-b", "main");
mkdirSync(join(dir, ".chant", "op-waves"), { recursive: true });
writeFileSync(join(dir, ".chant", "pipeline.ts"), PIPELINE);
git("add", ".chant/pipeline.ts");
git("commit", "-qm", "the pipeline");
const head = git("rev-parse", "HEAD");

const folded = foldPipelineSource(PIPELINE);
if (!("spec" in folded)) throw new Error("the pipeline does not fold");
/** The stage's spec file as the promote writes it, with `edit` applied to what lands on disk. */
const writeStageSpec = (stage: string, edit: (spec: Record<string, unknown>) => Record<string, unknown> = (s) => s) => {
  const file = `.chant/op-waves/yodel-apply-${stage}.spec.json`;
  writeFileSync(join(dir, file), `${JSON.stringify(edit(stageRunSpec(folded.spec, stage) as unknown as Record<string, unknown>), null, 2)}\n`);
  return file;
};
const plan = (environment: string) => ({ planDigest: `sha256:${"a".repeat(64)}`, environment, destructive: false, empty: false });

describe("a later stage's wave policy, as the engine reads it", () => {
  it("names the stage's own spec file in the step, as the promote hands it over", () => {
    expect(stageRunSpec(folded.spec, "prod").step).toMatchObject({ kind: "sql-migrate", spec: ".chant/op-waves/yodel-apply-prod.spec.json" });
  });

  it("reads each wave's gate from the pipeline at the default branch's commit", async () => {
    const staging = await forecastWave(dir, writeStageSpec("staging"), plan("staging"));
    expect(staging).toMatchObject({ name: "staging", policy: "never", base: head, waits: false });
    const prod = await forecastWave(dir, writeStageSpec("prod"), plan("prod"));
    expect(prod).toMatchObject({ name: "prod", policy: "always", base: head, waits: true });
  });

  it("keeps the pipeline's gate when the spec file on disk says otherwise", async () => {
    const loosened = writeStageSpec("prod", (spec) => ({ ...spec, waves: (spec.waves as Array<Record<string, unknown>>).map((w) => ({ ...w, gate: "never" })) }));
    expect(await forecastWave(dir, loosened, plan("prod"))).toMatchObject({ policy: "always", waits: true });
    expect(await forecastWave(dir, `./${loosened}`, plan("prod"))).toMatchObject({ policy: "always", waits: true });
  });
});
