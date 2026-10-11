/**
 * src/release (#208): the schema an environment holds, as a release record
 * on chant's ledger, and chant's `components status --compare-to` reading it.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readReleaseLedger } from "@intentius/chant/lifecycle/release-ledger";
import type { BuildOutput } from "../src/chant/build.js";
import type { Migration } from "../src/migrations/index.js";
import { schemaSha } from "../src/migrations/checkpoint.js";
import { loadProject, type Environment, type SqlProfile } from "../src/project.js";
import { appliedHead, recordRelease, recordReleaseLines } from "../src/release/index.js";
import { projectFrom } from "./helpers/run.js";

const m = (id: string) => ({ id, document: { schema: { dialect: "clickhouse", id } } }) as unknown as Migration;
const applied = (...ids: string[]) => ids.map((id) => ({ id }) as VersionedApplied);
type VersionedApplied = Parameters<typeof appliedHead>[1]["applied"][number];

describe("appliedHead", () => {
  const chain = [m("a"), m("b"), m("c")];

  it("is the newest applied migration when none before it is pending", () => {
    expect(appliedHead(chain, { applied: applied("a", "b") })?.id).toBe("b");
    expect(appliedHead(chain, { applied: applied("a", "b", "c") })?.id).toBe("c");
  });

  it("is none when nothing is applied, or an out-of-order apply left a gap", () => {
    expect(appliedHead(chain, { applied: [] })).toBeUndefined();
    expect(appliedHead(chain, { applied: applied("a", "c") })).toBeUndefined();
  });

  it("passes over the migrations a checkpoint leaves out", () => {
    expect(appliedHead(chain, { applied: applied("b", "c"), skipped: [{ id: "a", reason: "covered", checkpoint: "b" }] })?.id).toBe("c");
  });
});

describe("recordRelease", () => {
  const p = projectFrom("clickhouse-versioned");
  afterAll(() => {
    p.dispose();
  });
  const env = (name: string, tenant?: string): Environment => ({
    name: tenant ? `${name}/${tenant}` : name,
    profile: {} as SqlProfile,
    ...(tenant ? { tenant: { env: name, name: tenant, template: "shop" } } : {}),
  });
  const v1 = { dialect: "clickhouse", objects: { a: 1 } } as unknown as BuildOutput;
  const v2 = { dialect: "clickhouse", objects: { a: 2 } } as unknown as BuildOutput;
  const chant = (...args: string[]) =>
    JSON.parse(execFileSync(join(p.dir, "node_modules", ".bin", "chant"), args, { cwd: p.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as {
      comparisons: Array<{ component: string; digestA?: string; digestB?: string; same: boolean }>;
    };

  it("appends the schema's digest under the project's component, and chant compares two environments by it", async () => {
    const project = await loadProject(p.dir);
    const staging = await recordRelease(project, env("staging"), v1, { approver: "alice" });
    expect(staging).toMatchObject({ recorded: true, component: "schema", env: "staging", digest: schemaSha(v1), pushed: false });
    await recordRelease(project, env("prod"), v1);
    const { records } = await readReleaseLedger("staging", { cwd: p.dir });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ component: "schema", env: "staging", digest: schemaSha(v1), approver: "alice" });
    expect(records[0]?.gitSha).toMatch(/^[0-9a-f]{40}$/);

    expect(chant("components", "status", "prod", "--compare-to", "staging", "--json").comparisons).toEqual([
      expect.objectContaining({ component: "schema", digestA: schemaSha(v1), digestB: schemaSha(v1), same: true }),
    ]);
    await recordRelease(project, env("prod"), v2);
    expect(chant("components", "status", "prod", "--compare-to", "staging", "--json").comparisons).toEqual([
      expect.objectContaining({ component: "schema", digestA: schemaSha(v2), digestB: schemaSha(v1), same: false }),
    ]);
  }, 60_000);

  it("records a tenant on its environment's ledger as <component>/<tenant>", async () => {
    const project = await loadProject(p.dir);
    expect(await recordRelease(project, env("prod", "acme"), v1)).toMatchObject({ recorded: true, component: "schema/acme", env: "prod" });
  });

  it("says why it recorded nothing rather than failing the run", async () => {
    const project = await loadProject(p.dir);
    expect(await recordReleaseLines(project, env("prod"), undefined)).toEqual([expect.stringMatching(/^release: not recorded; prod's schema is none a migration recorded/)]);
  });
});
