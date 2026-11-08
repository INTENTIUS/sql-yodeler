/**
 * `/yodel new` (#312) and `/yodel rebase` (#313): chant's commit job,
 * rendered from the sql lexicon's `yodelCommitSpec` (chant pull request
 * 4798). A job with no forge token runs the command on the pull request's
 * head, in a worktree, and a second job holding the push token pushes what
 * it changed to the branch. chant refuses a pull request from a fork, a
 * commenter who cannot write, a change outside `migrations/`, a head the
 * job pushed itself and a fourth push to one pull request.
 *
 * - `new` runs `yodel new [<name>] --if-changed --replace-own --env <env>...`
 *   with each environment's reader variables, so `--replace-own` reads the
 *   histories and refuses a migration one of them records (chant pull
 *   request 4834). `/yodel new <name>` names the migration: chant hands the
 *   comment's argument to the command (chant pull request 4835).
 * - `rebase` merges the base branch into the head first (`mergeBase`), as a
 *   fork shows only on that merge, then runs `yodel rebase --env <env>...`
 *   with each environment's reader variables and nothing of a writer
 *   (`commandEnv`). The environments are every one the apply pipeline
 *   applies, since any of them may hold the other branch's migrations.
 *
 * yodel.config.ts `ci.respond.<word>` picks the triggers:
 *
 * - `comment` (the default): the job answers `/yodel <word>`.
 * - `on-change` (new) or `on-fork` (rebase): that, and a check on each push
 *   to a pull request, `yodel lint --commit-trigger <word>`, which exits
 *   with chant's `drift` code (2) when lint finds `unmigrated` or `fork`;
 *   the commit job follows it then.
 * - `off`: nothing.
 *
 * On GitLab chant's check trigger is off unless asked for, so it is asked
 * for. GitLab runs a comment's job in a pipeline of the default branch,
 * which cannot read the merge request's target branch, so chant refuses
 * `mergeBase` there: `/yodel rebase` runs on GitLab through the check
 * trigger only, for `comment` and `on-fork` alike.
 *
 * GitHub and Forgejo get a workflow per job. GitLab gets a file per word,
 * which `.gitlab-ci.yml` includes; a comment there reaches the job as a
 * pipeline of the default branch started with `CHANT_COMMIT_PR` and
 * `CHANT_COMMIT=<word>` (chant's header in the file says how).
 *
 * The generator is each forge lexicon's `generateOpPipeline`, called
 * directly: chant's `generateOpsPipeline` looks every spec up as a declared
 * Op, and a commit job runs no Op.
 */

import { yodelCommitSetup, yodelCommitSpec, type YodelCommitOptions, type YodelCommitWord } from "@intentius/chant-lexicon-sql/yodel-run";
import type { RespondNew, RespondRebase } from "../config/define.js";
import { YODEL_WORDS } from "../ci-words.js";

/** The secret (GitHub, Forgejo) or protected variable (GitLab) the push job reads the token from. */
export const COMMIT_TOKEN_ENV = "YODEL_PUSH_TOKEN";

/** The GitLab file each word's commit jobs are in. */
export const GITLAB_COMMIT_FILES: Readonly<Record<YodelCommitWord, string>> = { new: ".gitlab/yodel-commit.gitlab-ci.yml", rebase: ".gitlab/yodel-rebase.gitlab-ci.yml" };
export const GITLAB_COMMIT_FILE = GITLAB_COMMIT_FILES.new;

/** The job that answers `/yodel <word>`, and the one after the check. */
export const commitJob = (word: YodelCommitWord): string => `yodel-${word}`;
export const checkJob = (word: YodelCommitWord): string => `yodel-${word}-check`;
export const NEW_JOB = commitJob("new");
export const NEW_CHECK_JOB = checkJob("new");

/** The check a commit job follows: lint, exiting 2 when it finds the word's finding (`unmigrated`, `fork`). */
export const checkCommand = (word: YodelCommitWord): string[] => ["yodel", "lint", "--commit-trigger", word];
export const NEW_CHECK_COMMAND = checkCommand("new");

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

/** What `/yodel new` and `/yodel rebase` read histories with: the environments, and their readers' variables. */
export interface HistoryReaders {
  envs: readonly string[];
  /** Every environment's reader variables, the URL first. */
  variables: readonly string[];
}

export interface CommitRender {
  /** The project directory, absolute, for the setup lines. */
  dir: string;
  /** `ci.respond.new`, default `comment`. */
  respond: RespondNew;
  /** `ci.respond.rebase`, default `comment`. */
  respondRebase?: RespondRebase;
  /** The histories both words read; none when a reader's password is cloud-minted, which the commit job gets no identity for. */
  readers?: HistoryReaders;
  image: string;
  /** The yodel image (`ci.image`): it carries yodel and chant, so nothing is installed. */
  yodelImage: boolean;
}

/** The commit jobs' specs of `word` for `forge`, the comment's first. */
export function commitSpecs(r: Pick<CommitRender, "dir" | "respond" | "respondRebase" | "readers" | "yodelImage">, forge: CommitForge, word: YodelCommitWord = "new"): { comment?: CommitOpSpec; check?: CommitOpSpec } {
  const respond = word === "new" ? r.respond : (r.respondRebase ?? "comment");
  if (respond === "off") return {};
  const setup = r.yodelImage ? [] : yodelCommitSetup({ dir: r.dir });
  const base: Omit<YodelCommitOptions, "on"> = {
    tokenEnv: COMMIT_TOKEN_ENV,
    ...(r.readers && r.readers.envs.length > 0 ? { envs: r.readers.envs, readerVariables: r.readers.variables } : {}),
  };
  const spec = (name: string, commit: Record<string, unknown>): CommitOpSpec => ({ name, trigger: { kind: "pull_request" }, commit, ...(setup.length > 0 ? { setup } : {}) });
  // chant runs the check trigger on GitLab only when asked (gitlabCheck).
  const check = () => spec(checkJob(word), { ...yodelCommitSpec(word, { ...base, on: "check" }), ...(forge === "gitlab" ? { gitlabCheck: true } : {}) });
  // GitLab refuses mergeBase on a comment job: /yodel rebase runs there on the check trigger only.
  if (word === "rebase" && forge === "gitlab") return { check: check() };
  const comment = spec(commitJob(word), { ...yodelCommitSpec(word, { ...base, on: "comment" }) });
  return respond === "comment" ? { comment } : { comment, check: check() };
}

/**
 * The commit jobs' files of `word` for `forge`, each YAML as the lexicon
 * emits it. The words are made active while they render, so the jobs'
 * chant lines run through `yodel chant` and the comment reads `/yodel
 * <word>`.
 */
export async function commitFiles(r: CommitRender, forge: CommitForge, word: YodelCommitWord = "new"): Promise<Array<{ name: string; yaml: string }>> {
  const { comment, check } = commitSpecs(r, forge, word);
  if (!comment && !check) return [];
  const { withProductWords } = (await import("@intentius/chant/ci-product-words")) as {
    withProductWords: <T>(words: unknown, fn: () => Promise<T>) => Promise<T>;
  };
  const plugin = await pluginOf(forge);
  const options = { image: r.image, ...(forge === "gitlab" ? { opsStage: "ops", opsFileName: GITLAB_COMMIT_FILES[word] } : {}) };
  const runCommand = checkCommand(word);
  return withProductWords(YODEL_WORDS, () => {
    const files: Array<{ name: string; yaml: string }> = [];
    if (forge === "gitlab") {
      // One file per word: its comment's jobs and its check's, under stage ops.
      files.push(...(plugin.generateOpPipeline([...(comment ? [comment] : []), ...(check ? [check] : [])], { ...options, runCommand }).files ?? []));
    } else {
      if (comment) files.push(...(plugin.generateOpPipeline([comment], options).files ?? []));
      if (check) files.push(...(plugin.generateOpPipeline([check], { ...options, runCommand }).files ?? []));
    }
    return Promise.resolve(files);
  });
}
