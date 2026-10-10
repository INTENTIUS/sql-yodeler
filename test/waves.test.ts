import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { checkYodelConfig, loadYodelConfigAtBase } from "../src/config/index.js";
import { readWaves } from "../src/ci/render.js";
import { describeWave, destructiveSteps, promotionRefusal, requiredIn, waveGate, wavePlanDigest } from "../src/waves/index.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("yodel.config.ts waves", () => {
  const check = (waves: unknown) => () => checkYodelConfig({ waves }, "/p/yodel.config.ts", ["dev", "staging", "prod"]);

  it("takes environments in order, each with a gate policy", () => {
    expect(check([{ env: "dev", gate: "never" }, { env: "staging" }, { env: "prod", gate: "on-destructive" }])).not.toThrow();
  });

  it("refuses an environment chant.config.ts does not declare, one named twice, and a gate that is not a policy", () => {
    expect(check([{ env: "qa" }])).toThrow(/waves\[0\]\.env: qa is not an environment chant.config.ts declares \(sql.profiles: dev, staging, prod\)/);
    expect(check([{ env: "dev" }, { env: "dev" }])).toThrow(/waves\[1\]\.env: dev has a wave already/);
    expect(check([{ env: "dev", gate: "sometimes" }])).toThrow(/waves\[0\]\.gate: "sometimes" is not a gate policy \(expected always, on-destructive, never\)/);
    expect(check([{ env: "dev", when: "always" }])).toThrow(/waves\[0\]\.when: unknown setting/);
    expect(check({ dev: "always" })).toThrow(/waves: expected a list/);
  });

  it("points on-destroy, terragucci's spelling, at on-destructive", () => {
    expect(check([{ env: "dev", gate: "on-destroy" }])).toThrow(
      /waves\[0\]\.gate: "on-destroy" is not a gate policy \(expected always, on-destructive, never\)\. on-destroy is terragucci's name for this policy; SQL Yodeler and chant call it on-destructive/,
    );
    expect(check([{ env: "dev", gate: "sometimes" }])).not.toThrow(/terragucci/);
  });

  it("points on-destroy at on-destructive when yodel ci reads the waves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-waves-"));
    temps.push(dir);
    writeFileSync(join(dir, "yodel.config.ts"), 'export default { waves: [{ env: "dev", gate: "on-destroy" }] };\n');
    await expect(readWaves(dir, ["dev"])).rejects.toThrow(/"?on-destroy"? is not .*on-destroy is terragucci's name for this policy; SQL Yodeler and chant call it on-destructive/);
  });

  it("gives an environment no wave names the gate always", () => {
    expect(waveGate({ waves: [{ env: "prod", gate: "never" }] }, "prod")).toEqual({ gate: "never", declared: true });
    expect(waveGate({ waves: [{ env: "prod" }] }, "prod")).toEqual({ gate: "always", declared: true });
    expect(waveGate({ waves: [{ env: "prod" }] }, "dev")).toEqual({ gate: "always", declared: false });
    expect(waveGate(undefined, "dev")).toEqual({ gate: "always", declared: false });
  });
});

const stmt = (s: Partial<Extract<MigrationStep, { kind: "statement" }>>): MigrationStep =>
  ({ kind: "statement", object: "t", type: "Postgres::Table", name: "s.t", sql: "ALTER TABLE s.t ADD COLUMN c text", rule: "SQLPG201", class: "metadata", transactional: true, ...s });
const pending = (id: string, steps: MigrationStep[]) => ({ id, migration: { document: { steps } } }) as unknown as Parameters<typeof destructiveSteps>[1][number];

describe("what on-destructive waits on", () => {
  it("a column add is not destructive", () => {
    expect(destructiveSteps("postgres", [pending("m1", [stmt({})])])).toEqual([]);
  });

  it("a drop, a Postgres rewrite, a ClickHouse mutation, and any Op or manual step are", () => {
    const drop = stmt({ sql: "ALTER TABLE s.t DROP COLUMN c", rule: "SQLPG202", class: "destructive", destructive: true });
    const rewrite = stmt({ sql: "ALTER TABLE s.t ALTER COLUMN c TYPE bigint", rule: "SQLPG204", class: "rewrite" });
    expect(destructiveSteps("postgres", [pending("m1", [stmt({}), drop]), pending("m2", [rewrite])]).map((d) => [d.migration, d.step, d.why])).toEqual([
      ["m1", 1, "destructive"],
      ["m2", 0, "pg-rewrite"],
    ]);
    const mutation = stmt({ type: "ClickHouse::Table", sql: "ALTER TABLE d.t MODIFY COLUMN c UInt64", rule: "SQLCH203", class: "rewrite", transactional: false, waitsForMutation: true });
    expect(destructiveSteps("clickhouse", [pending("m3", [mutation])]).map((d) => d.why)).toEqual(["ch-mutation"]);
    const manual = { kind: "manual", object: "t", type: "Postgres::Table", name: "s.t", detail: "by hand", changes: [] } as unknown as MigrationStep;
    const op = { kind: "op", object: "t", type: "Postgres::Table", name: "s.t", op: "PostgresMigrationOp", importPath: "x", options: {}, declaration: "", changes: [], detail: "" } as unknown as MigrationStep;
    expect(destructiveSteps("postgres", [pending("m4", [manual, op])]).map((d) => d.why)).toEqual(["manual-step", "op-step"]);
  });
});

describe("the wave plan digest", () => {
  it("moves with the gate policy and with destructiveness, not only with the migrations", async () => {
    const base = { environment: "prod", migrations: "jcs1-sha256:" + "0".repeat(64), gate: "always" as const, destructive: false };
    const d = await wavePlanDigest(base);
    expect(await wavePlanDigest({ ...base })).toBe(d);
    expect(await wavePlanDigest({ ...base, gate: "never" })).not.toBe(d);
    expect(await wavePlanDigest({ ...base, destructive: true })).not.toBe(d);
  });
});

describe("yodel.config.ts at the base commit", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const config = (gate: string) => `export default { waves: [{ env: "prod", gate: "${gate}" }] };\n`;

  it("is read at the first parent, so a change that loosens a gate is gated by the old one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-base-"));
    temps.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    writeFileSync(join(dir, "yodel.config.ts"), config("always"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    writeFileSync(join(dir, "yodel.config.ts"), config("never"));
    git(dir, "commit", "-qam", "the change");

    const at = await loadYodelConfigAtBase(dir, {});
    expect(at.base.ref).toBe("HEAD^1");
    expect(at.config).toEqual({ waves: [{ env: "prod", gate: "always" }] });
    // YODEL_BASE names another commit: here the change itself.
    const head = await loadYodelConfigAtBase(dir, { YODEL_BASE: "HEAD" });
    expect(waveGate(head.config, "prod").gate).toBe("never");
  });

  it("is undefined when the base has no yodel.config.ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-base-"));
    temps.push(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@example.invalid");
    git(dir, "config", "user.name", "t");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "base");
    writeFileSync(join(dir, "yodel.config.ts"), config("never"));
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "the change");
    const at = await loadYodelConfigAtBase(dir, {});
    expect(at.config).toBeUndefined();
    expect(waveGate(at.config, "prod").gate).toBe("always");
  });
});

describe("the wave in yodel plan", () => {
  const view = { wave: 2, gate: "on-destructive" as const, base: "a".repeat(40), baseSource: "HEAD^1", planDigest: "p", digest: "jcs1-sha256:d", approve: "chant approve yodel-apply yodel-apply-wave-2 --plan jcs1-sha256:d", promotions: [], blocked: false };
  it("says whether the pipeline waits, and why", () => {
    expect(describeWave({ ...view, destructiveSteps: [], waits: false })).toBe("The apply pipeline applies this in wave 2 with no approval (gate on-destructive at aaaaaaaaaaaa: nothing pending is destructive).");
    expect(describeWave({ ...view, destructiveSteps: [{ migration: "m1", step: 0, what: "", why: "destructive" }], waits: true })).toBe(
      "The apply pipeline waits in wave 2 for an approval of jcs1-sha256:d (gate on-destructive at aaaaaaaaaaaa: m1 step 0 (destructive)).",
    );
    expect(describeWave({ ...view, gate: "never", destructiveSteps: [], waits: false })).toBe("The apply pipeline applies this in wave 2 with no approval (gate never at aaaaaaaaaaaa).");
    const promotions = [{ env: "staging", from: "yodel.config.ts", migrations: [{ id: "m1", checksum: "c", ran: "not applied" as const }] }];
    expect(describeWave({ ...view, destructiveSteps: [], waits: false, promotions, blocked: true })).toBe(
      "The apply pipeline refuses this in wave 2 until staging has applied it; approve it then (gate on-destructive at aaaaaaaaaaaa).",
    );
  });
});

describe("promotion", () => {
  it("requires the wave before unless a wave names another or false", () => {
    const config = { waves: [{ env: "dev" }, { env: "staging" }, { env: "prod", requires: "dev" }, { env: "qa", requires: false as const }] };
    expect(requiredIn(config, "dev")).toBeUndefined();
    expect(requiredIn(config, "staging")).toBe("dev");
    expect(requiredIn(config, "prod")).toBe("dev");
    expect(requiredIn(config, "qa")).toBeUndefined();
    expect(requiredIn(config, "elsewhere")).toBeUndefined();
    expect(requiredIn(undefined, "prod")).toBeUndefined();
  });

  it("refuses, exit 4, naming the environment and each migration it has not applied with the same checksum", () => {
    const ok = { env: "staging", from: "yodel.config.ts", migrations: [{ id: "m1", checksum: "c1", ran: "applied" as const }] };
    expect(promotionRefusal("prod", [ok])).toBeUndefined();
    const refusal = promotionRefusal("prod", [
      {
        env: "staging",
        from: "yodel.config.ts",
        migrations: [
          { id: "m1", checksum: "c1", ran: "applied" },
          { id: "m2", checksum: "c2", ran: "not applied" },
          { id: "m3", checksum: "c3", ran: "applied with another checksum", recorded: "c0" },
        ],
      },
    ]);
    expect(refusal?.exitCode).toBe(4);
    expect(refusal?.message).toBe(
      "refused: prod applies only migrations staging applied first, and 2 pending ones have not run there:\n" +
        "  m2: staging's history does not record it applied (required by yodel.config.ts)\n" +
        "  m3: staging applied it with checksum c0, and its files now hash to c3 (required by yodel.config.ts)\n" +
        "Nothing was applied. Apply them to staging first.",
    );
  });

  it("takes requires in yodel.config.ts, refusing one that is not an environment or is the wave's own", () => {
    const check = (waves: unknown) => () => checkYodelConfig({ waves }, "/p/yodel.config.ts", ["dev", "prod"]);
    expect(check([{ env: "dev" }, { env: "prod", requires: "dev" }])).not.toThrow();
    expect(check([{ env: "dev" }, { env: "prod", requires: false }])).not.toThrow();
    expect(check([{ env: "prod", requires: "qa" }])).toThrow(/waves\[0\]\.requires: qa is not an environment/);
    expect(check([{ env: "prod", requires: "prod" }])).toThrow(/prod cannot require itself/);
  });
});
