/**
 * `/yodel new` (#312): chant's commit job, rendered from the sql lexicon's
 * `yodelCommitSpec` (chant pull request 4798). The job runs `yodel new
 * --if-changed --replace-own` on the pull request's head, in a worktree
 * with no forge token, and a second job holding the push token pushes what
 * it wrote to the branch. chant refuses a pull request from a fork, a
 * commenter who cannot write, a change outside `migrations/`, a head the
 * job pushed itself and a fourth push to one pull request.
 *
 * yodel.config.ts `ci.respond.new` picks the triggers:
 *
 * - `comment` (the default): the job answers `/yodel new` on a pull
 *   request.
 * - `on-change`: that, and a check after each push to a pull request,
 *   `yodel lint --commit-trigger new`, which exits with chant's `drift`
 *   code (2) when lint finds `unmigrated`; the commit job follows it then.
 *   On GitLab, where chant's check trigger is off unless asked for, it is
 *   asked for.
 * - `off`: nothing.
 *
 * GitHub and Forgejo get a workflow per job, `yodel-new.yml` and
 * `yodel-new-check.yml`. GitLab gets one file, {@link GITLAB_COMMIT_FILE},
 * which `.gitlab-ci.yml` includes; a comment there reaches the job as a
 * pipeline of the default branch started with `CHANT_COMMIT_PR` and
 * `CHANT_COMMIT=new` (chant's header in the file says how).
 *
 * The generator is each forge lexicon's `generateOpPipeline`, called
 * directly: chant's `generateOpsPipeline` looks every spec up as a declared
 * Op, and a commit job runs no Op.
 */

import { yodelCommitSetup, yodelCommitSpec, type YodelCommitOptions } from "@intentius/chant-lexicon-sql/yodel-run";
import type { RespondNew } from "../config/define.js";
import { YODEL_WORDS } from "../ci-words.js";

/** The secret (GitHub, Forgejo) or protected variable (GitLab) the push job reads the token from. */
export const COMMIT_TOKEN_ENV = "YODEL_PUSH_TOKEN";

/** The GitLab file the commit jobs are in. */
export const GITLAB_COMMIT_FILE = ".gitlab/yodel-commit.gitlab-ci.yml";

/** The job that answers `/yodel new`, and the one after the check. */
export const NEW_JOB = "yodel-new";
export const NEW_CHECK_JOB = "yodel-new-check";

/** The check the `on-change` commit job follows: lint, exiting 2 when it finds `unmigrated`. */
export const NEW_CHECK_COMMAND = ["yodel", "lint", "--commit-trigger", "new"];

export type CommitForge = "github" | "gitlab" | "forgejo";

/** A commit job's spec as the forge lexicons generate it: chant's `ScheduledOpSpec` with `commit`. */
interface CommitOpSpec {
  name: string;
  trigger: { kind: "pull_request" };
  commit: Record<string, unknown>;
  setup?: Array<{ run: string }>;
}

interface LexiconPlugin {
  generateOpPipeline: (ops: unknown[], options: Record<string, unknown>) => { files?: Array<{ name: string; yaml: string }> };
}

async function pluginOf(forge: CommitForge): Promise<LexiconPlugin> {
  const mod = (await import(`@intentius/chant-lexicon-${forge}`)) as Record<string, unknown>;
  const plugin = Object.values(mod).find((v): v is LexiconPlugin => typeof (v as Partial<LexiconPlugin> | undefined)?.generateOpPipeline === "function");
  if (!plugin) throw new Error(`@intentius/chant-lexicon-${forge} has no generateOpPipeline`);
  return plugin;
}

export interface CommitRender {
  /** The project directory, absolute, for the setup lines. */
  dir: string;
  respond: RespondNew;
  image: string;
  /** The yodel image (`ci.image`): it carries yodel and chant, so nothing is installed. */
  yodelImage: boolean;
}

/** The commit jobs' specs for `respond`, the comment's first. */
export function commitSpecs(r: Pick<CommitRender, "dir" | "respond" | "yodelImage">, forge: CommitForge): { comment?: CommitOpSpec; check?: CommitOpSpec } {
  if (r.respond === "off") return {};
  const setup = r.yodelImage ? [] : yodelCommitSetup({ dir: r.dir });
  const base: Omit<YodelCommitOptions, "on"> = { tokenEnv: COMMIT_TOKEN_ENV };
  const spec = (name: string, commit: Record<string, unknown>): CommitOpSpec => ({ name, trigger: { kind: "pull_request" }, commit, ...(setup.length > 0 ? { setup } : {}) });
  const comment = spec(NEW_JOB, { ...yodelCommitSpec("new", { ...base, on: "comment" }) });
  if (r.respond !== "on-change") return { comment };
  // chant runs the check trigger on GitLab only when asked (gitlabCheck).
  const check = spec(NEW_CHECK_JOB, { ...yodelCommitSpec("new", { ...base, on: "check" }), ...(forge === "gitlab" ? { gitlabCheck: true } : {}) });
  return { comment, check };
}

/**
 * The commit jobs' files for `forge`, each YAML as the lexicon emits it.
 * The words are made active while they render, so the jobs' chant lines
 * run through `yodel chant` and the comment reads `/yodel new`.
 */
export async function commitFiles(r: CommitRender, forge: CommitForge): Promise<Array<{ name: string; yaml: string }>> {
  const { comment, check } = commitSpecs(r, forge);
  if (!comment) return [];
  const { withProductWords } = (await import("@intentius/chant/ci-product-words")) as {
    withProductWords: <T>(words: unknown, fn: () => Promise<T>) => Promise<T>;
  };
  const plugin = await pluginOf(forge);
  const options = { image: r.image, ...(forge === "gitlab" ? { opsStage: "ops", opsFileName: GITLAB_COMMIT_FILE } : {}) };
  return withProductWords(YODEL_WORDS, () => {
    const files: Array<{ name: string; yaml: string }> = [];
    if (forge === "gitlab") {
      // One file: the comment's jobs and the check's, under stage ops.
      const all = [comment, ...(check ? [check] : [])];
      files.push(...(plugin.generateOpPipeline(all, { ...options, runCommand: NEW_CHECK_COMMAND }).files ?? []));
    } else {
      files.push(...(plugin.generateOpPipeline([comment], options).files ?? []));
      if (check) files.push(...(plugin.generateOpPipeline([check], { ...options, runCommand: NEW_CHECK_COMMAND }).files ?? []));
    }
    return Promise.resolve(files);
  });
}
