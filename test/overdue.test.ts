/**
 * src/pr/overdue.ts: `yodel plan --comment` warns when the environment's
 * drift watch has not run for two fires of its cron (chant#4289). The
 * project is the starter template's ops and rendered pipelines, in a git
 * repository of its own; the forge is chant's client over a fake fetch, or
 * a stand-in where only the verdict matters.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ForgeFetch, PrForge } from "@intentius/chant/pr-forge";
import { GITLAB_WATCH_FILE } from "../src/ci/render.js";
import { resolveForge } from "../src/pr/forge.js";
import { GITLAB_WATCH, overdueNotes, watchPipelineFile } from "../src/pr/overdue.js";
import { commentMarker, renderPlanMarkdown } from "../src/pr/render.js";

const ROOT = resolve(import.meta.dirname, "..");
const TEMPLATE = join(ROOT, "templates/postgres");
const NOW = new Date("2026-10-23T12:00:00.000Z");

const dir = mkdtempSync(join(tmpdir(), "yodel-overdue-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
mkdirSync(join(dir, "ops"));
for (const f of ["ops/watch-dev.op.ts", "ops/watch-prod.op.ts", ".github/workflows/watch-dev.yml", ".github/workflows/watch-prod.yml", GITLAB_WATCH]) cpSync(join(TEMPLATE, f), join(dir, f));
{
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z", GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z" } });
  execFileSync("sh", ["-c", "printf 'node_modules\\n' > .gitignore"], { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-qm", "init");
}

/** chant's GitHub client for acme/db#42 over a fake fetch: the watch workflow's state and its newest scheduled run. */
async function github(state: string, lastRun: string | undefined): Promise<{ client: PrForge; calls: string[] }> {
  const calls: string[] = [];
  const fetch: ForgeFetch = (url) => {
    calls.push(url);
    const send = (v: unknown) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(v)) });
    if (/\/actions\/workflows\/[^/]+$/.test(url)) return send({ state });
    if (url.includes("/runs?event=schedule") && lastRun) return send({ workflow_runs: [{ created_at: lastRun }] });
    return send({ workflow_runs: [] });
  };
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "acme/db", GITHUB_REF: "refs/pull/42/merge", GITHUB_TOKEN: "secret" };
  const { client } = await resolveForge({}, env, "--comment", fetch);
  return { client, calls };
}

describe("the overdue drift watch in the plan comment (chant#4289)", () => {
  it("warns when dev's watch last ran two fires of its cron ago, and asks about dev's workflow alone", async () => {
    const { client, calls } = await github("active", "2026-10-23T09:17:00Z");
    const log: string[] = [];
    const notes = await overdueNotes(dir, "dev", client, (l) => log.push(l), NOW);
    expect(notes).toEqual([
      "Warning: Op `watch-dev` is overdue: its schedule `17 * * * *` has fired at least twice and its last run was on 2026-10-23. GitHub turns a scheduled workflow off after 60 days with no activity in the repository. Turn the workflow on again under Actions, or run it by hand.",
    ]);
    expect(log).toEqual([`yodel plan: ${notes[0] ?? ""}`]);
    expect(calls.every((u) => u.includes("/actions/workflows/watch-dev.yml"))).toBe(true);
  });

  it("says nothing when the watch ran since the cron's last fire", async () => {
    const { client } = await github("active", "2026-10-23T11:17:00Z");
    expect(await overdueNotes(dir, "dev", client, () => undefined, NOW)).toEqual([]);
  });

  it("names GitHub's reason when it turned the workflow off", async () => {
    const { client } = await github("disabled_inactivity", "2026-08-01T00:17:00Z");
    const [note] = await overdueNotes(dir, "prod", client, () => undefined, NOW);
    expect(note).toContain("Op `watch-prod` is overdue: its schedule `47 * * * *`");
    expect(note).toContain("GitHub has turned the workflow off (disabled_inactivity)");
  });

  it("on GitLab reads yodel's watch file, and counts from the commit that added it when no schedule ever ran", async () => {
    const asked: string[] = [];
    const gitlab: Pick<PrForge, "kind" | "scheduledRuns"> = {
      kind: "gitlab",
      scheduledRuns: (q) => {
        asked.push(`${q.op} ${q.workflow}`);
        return Promise.resolve({ noSchedule: true });
      },
    };
    const [note] = await overdueNotes(dir, "dev", gitlab, () => undefined, NOW);
    expect(asked).toEqual([`watch-dev ${GITLAB_WATCH.split("/").pop() ?? ""}`]);
    expect(note).toContain("no run is on record since its pipeline was added on 2026-09-01");
    expect(note).toContain("No active pipeline schedule sets CHANT_SCHEDULED_OP to watch-dev");
  });

  it("logs a forge that will not answer, and warns about nothing", async () => {
    const refusing: Pick<PrForge, "kind" | "scheduledRuns"> = { kind: "github", scheduledRuns: () => Promise.reject(new Error("403 Resource not accessible by integration")) };
    const log: string[] = [];
    expect(await overdueNotes(dir, "dev", refusing, (l) => log.push(l), NOW)).toEqual([]);
    expect(log).toEqual(["yodel plan: github did not say when watch-dev last ran, so it is not checked: 403 Resource not accessible by integration"]);
  });

  it("finds the files yodel ci renders, and none for an environment without a watch", async () => {
    expect(GITLAB_WATCH).toBe(GITLAB_WATCH_FILE);
    expect(watchPipelineFile(dir, "github", "watch-dev")).toBe(".github/workflows/watch-dev.yml");
    expect(watchPipelineFile(dir, "forgejo", "watch-dev")).toBeUndefined();
    expect(watchPipelineFile(dir, "gitlab", "watch-staging")).toBeUndefined();
    const { client } = await github("active", undefined);
    expect(await overdueNotes(dir, "staging", client, () => undefined, NOW)).toEqual([]);
  });

  it("is a note in the comment's markdown", () => {
    const note = "Warning: Op `watch-dev` is overdue: its schedule `17 * * * *` has fired at least twice and its last run was on 2026-10-01.";
    const md = renderPlanMarkdown({ environment: "dev", dialect: "postgres", appliedCount: 0, pending: [], problems: [], notes: [note] } as never);
    expect(md.startsWith(commentMarker("dev"))).toBe(true);
    expect(md).toContain(`> ${note}`);
  });

  it("the GitHub plan workflow may read Actions, which the check needs", () => {
    const pr = readFileSync(join(TEMPLATE, ".github/workflows/yodel-pr.yml"), "utf8");
    expect(pr).toMatch(/^permissions:\n(?: {2}\S.*\n)*? {2}actions: read\n/m);
  });
});
