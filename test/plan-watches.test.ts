/**
 * The drift watches the plan note checks (sql-yodeler issue 346, chant
 * issue 4988): each environment's WatchOp goes to chant's product plan with
 * that environment as its only target, so an environment's note warns of
 * its own watch and not another environment's.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { watchesForTarget, type ScheduledWatch } from "@intentius/chant/op/schedule-overdue";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { render } from "../src/ci/render.js";
import { repoRoot } from "./helpers/run.js";

type Step = { env?: Record<string, string> };
type ActionsDoc = { jobs: Record<string, { steps: Step[] }> };
type GitLabDoc = Record<string, { variables?: Record<string, string> }>;

const watchesIn = (env: Record<string, string> | undefined): ScheduledWatch[] => JSON.parse(env?.CHANT_PLAN_WATCHES ?? "[]") as ScheduledWatch[];

describe("the plan note's watches, per environment (#346)", () => {
  it("name each environment's watch with that environment as its target, on every forge", async () => {
    const files = await render(join(repoRoot, "templates", "postgres"));
    const file = (path: string) => files.find((f) => f.path === path)?.content ?? "";
    const expected = [
      { op: "watch-dev", cron: expect.any(String) as string, targets: ["dev"] },
      { op: "watch-prod", cron: expect.any(String) as string, targets: ["prod"] },
    ];
    for (const path of [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml"]) {
      const jobs = (parseYAMLDocument(file(path)) as ActionsDoc).jobs;
      for (const env of ["dev", "prod"]) {
        const step = jobs[`plan-note-${env}`]?.steps.find((s) => s.env?.CHANT_PLAN_WATCHES !== undefined);
        expect(watchesIn(step?.env), `${path} plan-note-${env}`).toEqual(expected);
      }
    }
    const gitlab = parseYAMLDocument(file(".gitlab/yodel-plan.gitlab-ci.yml")) as GitLabDoc;
    const found = Object.values(gitlab).map((j) => j.variables?.CHANT_PLAN_WATCHES).filter((v): v is string => v !== undefined);
    expect(found.length).toBeGreaterThan(0);
    for (const v of found) expect(watchesIn({ CHANT_PLAN_WATCHES: v })).toEqual(expected);
    // chant's note job for an environment keeps that environment's watch alone.
    const all = watchesIn({ CHANT_PLAN_WATCHES: found[0] ?? "[]" });
    expect(watchesForTarget(all, "dev").map((w) => w.op)).toEqual(["watch-dev"]);
    expect(watchesForTarget(all, "prod").map((w) => w.op)).toEqual(["watch-prod"]);
  }, 60_000);
});
