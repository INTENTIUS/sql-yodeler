import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkYodelConfig, policyAtBase, type YodelConfig } from "../src/config/index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const NO_DROPS = `{ policy: { overriders: ["alice"], rules: [{ id: "no-drops", refuse: { classes: ["drop"] } }] } }`;

/** A repository whose base commit has `base` as yodel.config.ts (none when undefined) and whose working tree has `tree`. */
function repo(base: string | undefined, tree: string | undefined): { dir: string; yodel: { config: YodelConfig } | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "yodel-policy-base-"));
  temps.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  const file = join(dir, "yodel.config.ts");
  if (base !== undefined) writeFileSync(file, `export default ${base};\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  if (tree !== undefined) writeFileSync(file, `export default ${tree};\n`);
  else rmSync(file, { force: true });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "the change");
  // The working tree's config, as loadProject would have checked it.
  const config = tree === undefined ? undefined : (Function(`return (${tree});`)() as unknown);
  return { dir, yodel: config === undefined ? undefined : { config: checkYodelConfig(config, file) } };
}

describe("the plan policy at the base commit (#73)", () => {
  it("is the base's when a change deletes a rule, and says so", async () => {
    const at = await policyAtBase(repo(NO_DROPS, "{}"), {});
    expect(at.policy?.rules.map((r) => r.id)).toEqual(["no-drops"]);
    expect(at.note).toMatch(/^The policy applied is yodel.config.ts's at [0-9a-f]{12} /);
    const edited = await policyAtBase(repo(NO_DROPS, `{ policy: { rules: [{ id: "no-drops", environments: ["dev"], refuse: { classes: ["drop"] } }] } }`), {});
    expect(edited.policy?.rules[0]?.environments).toBeUndefined();
    expect(edited.note).toMatch(/^The policy applied is yodel.config.ts's at [0-9a-f]{12} \(HEAD\^1, the commit the change merged onto\), not the working tree's/);
  });

  it("is the base's even when the change removes yodel.config.ts", async () => {
    expect((await policyAtBase(repo(NO_DROPS, undefined), {})).policy?.rules.map((r) => r.id)).toEqual(["no-drops"]);
  });

  it("applies nothing new that the base does not have, and says so", async () => {
    const at = await policyAtBase(repo(undefined, NO_DROPS), {});
    expect(at.policy).toBeUndefined();
    expect(at.note).toMatch(/^yodel.config.ts at [0-9a-f]{12} \(HEAD\^1, the commit the change merged onto\) declares no policy, so none applies; the working tree's applies once it is on the branch\.$/);
  });

  it("says nothing when the base and the working tree agree", async () => {
    const at = await policyAtBase(repo(NO_DROPS, NO_DROPS), {});
    expect(at.policy?.rules.map((r) => r.id)).toEqual(["no-drops"]);
    expect(at.note).toBeUndefined();
  });

  it("YODEL_BASE names the commit to read at", async () => {
    const r = repo(NO_DROPS, "{}");
    expect((await policyAtBase(r, { YODEL_BASE: "HEAD" })).policy).toBeUndefined();
  });
});
