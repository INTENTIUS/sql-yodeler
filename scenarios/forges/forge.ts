/**
 * What the template claims need from a forge: a fresh repository with the
 * pipelines' secrets, the runs a push and a pull request start, the pull
 * request's comments, a merge, a run of the drift watch and the issues it
 * keeps. Forgejo and GitLab run the pipelines
 * themselves on a push; on GitHub, act runs them for the mock GitHub.
 */

import type { Ctx, Dialect } from "../lib/claim.js";

/** The job image: node and git, as the templates' Forgejo and GitLab jobs use. */
export const NODE_IMAGE = "node:22-bookworm";

/** A finished run: a workflow run, a set of act jobs, or a pipeline. */
export interface ForgeRun {
  ok: boolean;
  /** The forge's word for how it ended (success, failure, ...). */
  status: string;
  /** Every job's log, joined. */
  log: string;
  /** The names of the jobs that did not succeed, where the forge says. */
  failed?: string[];
  /** The forge's id of the run, where a resume names it. */
  id?: number;
}

export interface ForgeRepo {
  /** The URL to push to, with credentials. */
  remote: string;
  /** The run a push of `sha` to main started: the apply. */
  pushed(sha: string): Promise<ForgeRun>;
  /** The apply again, started by hand on main at `sha`. */
  applyAgain(sha: string): Promise<ForgeRun>;
  /** Opens a pull request from the pushed branch `head` (at `sha`) into main, and waits for its checks: every pull request workflow the project has. */
  openPr(head: string, sha: string, title: string): Promise<{ id: number; checks: ForgeRun }>;
  /**
   * Approves pull request `id`'s head `sha` in a review (#48): as its author,
   * or as `reviewer`, another user with write access to the repository. A
   * forge that refuses the author's own approval says so, and the caller
   * goes on with no review. Without it, the claim skips the pr-review part.
   */
  review?(id: number, sha: string, as: "author" | "reviewer"): Promise<void>;
  /** Sets these secrets (variables on GitLab) to new values; the runs started after see them. */
  setSecrets?(secrets: Record<string, string>): Promise<void>;
  /** The bodies of the pull request's comments. */
  comments(id: number): Promise<string[]>;
  /** Merges the pull request; main's sha after the merge. */
  merge(id: number): Promise<string>;
  /** Runs dev's drift watch (watch-dev) on main at `sha`, as its schedule would, and waits for it. */
  watch(sha: string): Promise<ForgeRun>;
  /** The repository's issues, open and closed (not pull requests). */
  issues(): Promise<ForgeIssue[]>;
  /**
   * What `yodel approve` resumes a waiting job with (#47): the token, with
   * the least access the forge's resume needs, and whatever else the
   * approver's machine needs to reach the forge's API as the job named it.
   * A forge without it is approved with chant approve and run again by hand.
   */
  resumeEnv?(): Promise<Record<string, string>>;
  /**
   * The run the forge started again for `waited` after its approval
   * resumed it, once finished; undefined when none started within `withinMs`.
   */
  resumed?(sha: string, waited: ForgeRun, withinMs: number): Promise<ForgeRun | undefined>;
}

export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  open: boolean;
}

export interface Forge {
  /** For messages: Forgejo, GitHub, GitLab. */
  name: string;
  /** The claim's server as the forge's jobs reach it. */
  jobUrl(dialect: Dialect): string;
  /** Starts what the forge needs and makes the repository `name`, fresh, with these secrets. */
  repo(ctx: Ctx, name: string, secrets: Record<string, string>): Promise<ForgeRepo>;
  /** Removes what `repo` started. */
  close(): Promise<void>;
}
