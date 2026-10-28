/**
 * The report bucket yodel's harness scenarios read (scenarios/harness/reports.ts):
 * pr-plan.json from the plan comment and the commit statuses, pr-apply.json
 * from the waves' run records, with fakes for the forge and the ledger.
 */

import { describe, expect, it } from "vitest";
import type { RunRecordView } from "../scenarios/harness/harness.js";
import { applyReport, jobOf, parseReportKey, planComment, planReport, readPlanComment, YodelReports, type CommitStatus } from "../scenarios/harness/reports.js";

const DIGEST = `jcs1-sha256:${"ab".repeat(32)}`;
const HEAD = "1".repeat(40);
const MERGE = "2".repeat(40);
const comment = (approve: string) => `<!-- yodel:plan env=dev -->\n### dev\n\nPlan digest the apply gate binds: \`${DIGEST}\`\n\n\`\`\`sh\n${approve}\n\`\`\`\n`;
const ok = (job: string): CommitStatus => ({ context: `yodel-pr / ${job} (pull_request)`, state: "success" });

let n = 0;
const wave = (name: string, number: number, status: RunRecordView["status"], gitSha = MERGE): RunRecordView => {
  n++;
  return { id: `r${String(n)}`, op: "yodel-apply", env: "local", started: `2026-11-02T10:00:${String(n).padStart(2, "0")}Z`, ended: `2026-11-02T10:01:${String(n).padStart(2, "0")}Z`, status, gitSha, wave: { number, name } };
};

describe("the plan report", () => {
  it("names each job from its status context", () => {
    expect(jobOf("yodel-pr / lint (pull_request)")).toBe("lint");
    expect(jobOf("yodel-pr / plan-dev (pull_request)")).toBe("plan-dev");
    expect(jobOf("yodel-pr / project-job")).toBe("project-job");
  });

  it("reads the digest and the gate from chant's approve line, and wave 1 from yodel's", () => {
    expect(readPlanComment(comment(`chant approve yodel-apply yodel-apply-wave-1 --plan ${DIGEST}`))).toEqual({ digest: DIGEST, op: "yodel-apply", gate: "yodel-apply-wave-1" });
    expect(readPlanComment(comment(`yodel approve dev --plan ${DIGEST}`))).toEqual({ digest: DIGEST, op: "yodel-apply", gate: "yodel-apply-wave-1" });
    expect(readPlanComment("no digest here")).toBeUndefined();
  });

  it("takes the newest plan comment of the environment", () => {
    expect(planComment(["<!-- yodel:plan env=prod -->a", "<!-- yodel:plan env=dev -->b", "<!-- yodel:plan env=dev -->c"], "dev")).toBe("<!-- yodel:plan env=dev -->c");
  });

  it("is not there while a job runs, or while every job passed and the comment is not posted", () => {
    expect(planReport(7, HEAD, [], undefined)).toBeNull();
    expect(planReport(7, HEAD, [ok("lint"), { context: "yodel-pr / plan-dev (pull_request)", state: "pending" }], undefined)).toBeNull();
    expect(planReport(7, HEAD, [ok("lint"), ok("plan-dev")], undefined)).toBeNull();
  });

  it("is planned with every job passed, under the comment's digest and gate", () => {
    const r = planReport(7, HEAD, [ok("lint"), ok("plan-dev"), ok("project-job")], comment(`chant approve yodel-apply yodel-apply-wave-1 --plan ${DIGEST}`));
    expect(r).toMatchObject({ stage: "plan", pr: 7, head: HEAD, status: "planned", op: "yodel-apply", gate: "yodel-apply-wave-1", digest: DIGEST });
    expect(r?.members.map((m) => `${m.component}:${m.status}`)).toEqual(["lint:passed", "plan-dev:passed", "project-job:passed"]);
  });

  it("is failed when a job failed, with or without a comment", () => {
    const r = planReport(8, HEAD, [{ context: "yodel-pr / lint (pull_request)", state: "failure" }, { context: "yodel-pr / plan-dev (pull_request)", state: "failure" }], undefined);
    expect(r).toMatchObject({ status: "failed", digest: "" });
    expect(r?.members.find((m) => m.component === "lint")?.status).toBe("failed");
  });
});

describe("the apply report", () => {
  it("is not there before wave 1 has a run on the merge commit", () => {
    expect(applyReport(3, MERGE, ["dev", "prod"], [wave("dev", 1, "ok", HEAD)])).toBeNull();
  });

  it("is gated while dev waits, with prod blocked behind it", () => {
    const r = applyReport(3, MERGE, ["dev", "prod"], [wave("dev", 1, "gated")]);
    expect(r).toMatchObject({ stage: "apply", status: "gated", gate: "yodel-apply-wave-1" });
    expect(r?.members.map((m) => `${m.component}:${m.status}`)).toEqual(["dev:gated", "prod:blocked"]);
  });

  it("takes each wave's newest run: dev applied after its approval, prod waiting", () => {
    const r = applyReport(3, MERGE, ["dev", "prod"], [wave("dev", 1, "gated"), wave("dev", 1, "ok"), wave("prod", 2, "gated")]);
    expect(r).toMatchObject({ status: "gated", gate: "yodel-apply-wave-2" });
    expect(r?.members.map((m) => `${m.component}:${m.status}`)).toEqual(["dev:applied", "prod:gated"]);
  });

  it("is applied when every wave applied, and failed when one failed", () => {
    expect(applyReport(3, MERGE, ["dev", "prod"], [wave("dev", 1, "ok"), wave("prod", 2, "ok")])?.status).toBe("applied");
    expect(applyReport(3, MERGE, ["dev"], [wave("dev", 1, "fail")])).toMatchObject({ status: "failed", members: [{ component: "dev", status: "failed" }] });
  });
});

describe("the report bucket", () => {
  it("parses chant's report keys", () => {
    expect(parseReportKey(`sy-forge-postgres/reports/7/${HEAD}/pr-plan.json`)).toEqual({ pr: 7, commit: HEAD, stage: "plan" });
    expect(parseReportKey(`p/main/${MERGE}/pr-apply.json`)).toEqual({ pr: null, commit: MERGE, stage: "apply" });
    expect(parseReportKey("p/7/zz/pr-plan.json")).toBeUndefined();
  });

  it("answers both reports from the forge and the ledger, and puts nothing", async () => {
    const bucket = new YodelReports(
      {
        comments: (pull) => Promise.resolve(pull === 7 ? [comment(`chant approve yodel-apply yodel-apply-wave-1 --plan ${DIGEST}`)] : []),
        statuses: (sha) => Promise.resolve(sha === HEAD ? [ok("lint"), ok("plan-dev")] : []),
        runs: (env, op) => Promise.resolve(env === "local" && op === "yodel-apply" ? [wave("dev", 1, "ok")] : []),
      },
      ["dev"],
    );
    const plan = JSON.parse((await bucket.get(`r/7/${HEAD}/pr-plan.json`)) ?? "null") as { status: string; digest: string };
    expect(plan).toMatchObject({ status: "planned", digest: DIGEST });
    const apply = JSON.parse((await bucket.get(`r/7/${MERGE}/pr-apply.json`)) ?? "null") as { status: string };
    expect(apply.status).toBe("applied");
    expect(await bucket.get("r/not-a-report")).toBeNull();
    await expect(bucket.put()).rejects.toThrow(/read only/);
  });
});
