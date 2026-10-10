/**
 * What the template claims need from a forge: a fresh repository with the
 * pipelines' secrets, the runs a push and a pull request start, the pull
 * request's comments, and a merge. Forgejo and GitLab run the pipelines
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
}

export interface ForgeRepo {
  /** The URL to push to, with credentials. */
  remote: string;
  /** The run a push of `sha` to main started: the apply. */
  pushed(sha: string): Promise<ForgeRun>;
  /** The apply again, started by hand on main at `sha`. */
  applyAgain(sha: string): Promise<ForgeRun>;
  /** Opens a pull request from the pushed branch `head` (at `sha`) into main, and waits for its checks. */
  openPr(head: string, sha: string, title: string): Promise<{ id: number; checks: ForgeRun }>;
  /** The bodies of the pull request's comments. */
  comments(id: number): Promise<string[]>;
  /** Merges the pull request; main's sha after the merge. */
  merge(id: number): Promise<string>;
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
