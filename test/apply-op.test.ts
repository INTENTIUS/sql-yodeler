import { describe, expect, it } from "vitest";
import { ApplyOp } from "@intentius/chant/op";
import type { OpConfig } from "@intentius/chant/op/types";
import { gatedCommands, readApplyRun, selectApplyOp } from "../src/chant/apply.js";
import { projectFromConfig, resolveEnvironment } from "../src/project.js";

const project = projectFromConfig("/p", "/p/chant.config.ts", {
  lexicons: ["sql"],
  sql: { dialect: "clickhouse", profiles: { dev: { url: "http://ch:8123" }, prod: { url: "http://ch2:8123" } } },
});
const dev = resolveEnvironment(project, "dev");

/** Ops as chant's discovery returns them, built with chant's own ApplyOp. */
function ops(...configs: Parameters<typeof ApplyOp>[0][]) {
  return new Map(
    configs.map((c) => {
      const config = (ApplyOp(c).op as unknown as { props: OpConfig }).props;
      return [config.name, { config, filePath: `/p/ops/${config.name}.op.ts` }] as const;
    }),
  );
}

describe("selectApplyOp", () => {
  it("picks the gated ApplyOp that applies the environment", () => {
    const found = ops(
      { name: "apply-dev", env: "dev", target: "clickhouse", gate: {} },
      { name: "apply-prod", env: "prod", target: "clickhouse", delete: "gated" },
    );
    expect(selectApplyOp(found, project, dev)).toEqual({
      name: "apply-dev",
      filePath: "/p/ops/apply-dev.op.ts",
      target: "clickhouse",
      gate: "approve-apply-dev",
    });
  });

  it("refuses an ApplyOp without a gate bound to its plan", () => {
    expect(() => selectApplyOp(ops({ name: "apply-dev", env: "dev", target: "clickhouse" }), project, dev)).toThrow(
      /no approval gate bound to its plan/,
    );
  });

  it("says how to declare one when none applies the environment", () => {
    expect(() => selectApplyOp(ops({ name: "apply-prod", env: "prod", target: "clickhouse", gate: {} }), project, dev)).toThrow(
      /no ApplyOp applies environment dev[\s\S]*ApplyOp\(\{ name: "apply-dev", env: "dev", target: "clickhouse", gate: \{\} \}\)/,
    );
    expect(() => selectApplyOp(ops({ name: "k8s", env: "dev", target: "kubectl", gate: {} }), project, dev)).toThrow(/no ApplyOp applies/);
  });

  it("asks for --op when two apply the same environment, and takes it", () => {
    const found = ops(
      { name: "a", env: "dev", target: "clickhouse", gate: {} },
      { name: "b", env: "dev", target: "clickhouse", gate: {} },
    );
    expect(() => selectApplyOp(found, project, dev)).toThrow(/2 Ops apply environment dev \(a, b\); pick one with --op/);
    expect(selectApplyOp(found, project, dev, "b").name).toBe("b");
    expect(() => selectApplyOp(found, project, dev, "c")).toThrow(/no Op named "c"/);
  });

  it("refuses an Op for the other dialect", () => {
    expect(() => selectApplyOp(ops({ name: "pg", env: "dev", target: "postgres", gate: {} }), project, dev)).toThrow(
      /applies target postgres, but the project's dialect is clickhouse/,
    );
  });
});

describe("readApplyRun", () => {
  it("reads a gated run's approve line and plan digest", () => {
    const output = [
      'Op "apply-e2e" is gated on "approve-apply-e2e" after 1.8s',
      "  plan    : jcs1-sha256:abc",
      "  approve : chant approve apply-e2e approve-apply-e2e --plan jcs1-sha256:abc",
    ].join("\n");
    const run = readApplyRun(3, output);
    expect(run).toMatchObject({
      status: "gated",
      chantApprove: "chant approve apply-e2e approve-apply-e2e --plan jcs1-sha256:abc",
      planDigest: "jcs1-sha256:abc",
    });
    // A person is told to run yodel approve (#202); chant's command stays for scripts.
    expect(gatedCommands(run, "e2e")).toEqual({ approve: "yodel approve e2e --plan jcs1-sha256:abc", chantApprove: "chant approve apply-e2e approve-apply-e2e --plan jcs1-sha256:abc" });
  });

  it("prints yodel approve with --sign where the gate is sealed, and seals chant's command too (#202)", () => {
    const run = { chantApprove: "chant approve migrate-prod approve-migrate-prod --plan d" };
    expect(gatedCommands(run, "prod", "sealed")).toEqual({ approve: "yodel approve prod --plan d --sign", chantApprove: "chant approve migrate-prod approve-migrate-prod --plan d --sign" });
    expect(gatedCommands({ chantApprove: "chant approve a b --plan d --sign" }, "prod")).toEqual({ approve: "yodel approve prod --plan d --sign", chantApprove: "chant approve a b --plan d --sign" });
    expect(gatedCommands({}, "prod")).toEqual({});
  });

  it("maps chant run's exit codes", () => {
    expect(readApplyRun(0, "").status).toBe("applied");
    expect(readApplyRun(1, "").status).toBe("failed");
  });
});
