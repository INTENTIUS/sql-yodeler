/**
 * The migrations a pull request adds, as one chant change-set document (#304),
 * read from the files alone: no server, no history, no credential. `yodel
 * plan --pull-request --change-set <file>` writes it, and the review agent's
 * Op hands it to chant's `reviewAgent`, whose job holds no database
 * credential.
 *
 * The added migrations are those in the checkout's migrations directory that
 * the base commit's does not have, in chain order. A migration is
 * environment-independent, so the document has one member, `migrations`,
 * whatever environments the project has. Each step's class and rule come from
 * its `migration.json`, as `yodel new` classified them, through the sql
 * lexicon's `sqlVersionedPlanPart`, the same adapter the plan note's part
 * uses (./part.ts). Statements are redacted as in `--json`.
 *
 * The base is, first one that applies: `YODEL_BASE`; GitLab's
 * `CI_MERGE_REQUEST_DIFF_BASE_SHA`, the merge request's diff base; the rule
 * of `../config/base.ts` (the merge base with the target branch, else
 * `HEAD^1`).
 */

import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { composeChangeSet, type ChangeSetDocument } from "@intentius/chant/change-set";
import { sqlVersionedPlanPart } from "@intentius/chant-lexicon-sql/change-set";
import { BASE_ENV, baseRef, type BaseRef } from "../config/base.js";
import { scanMigrations, type Migration } from "../migrations/index.js";
import { YodelError, type Project } from "../project.js";
import { migrationsDir } from "../versioned/index.js";
import { redact } from "./render.js";

/** The change set's one member: the migrations, before any environment. */
export const PULL_REQUEST_MEMBER = "migrations";

export interface AddedMigrations {
  base: BaseRef;
  /** The commit the base resolved to. */
  sha: string;
  /** The migrations the base does not have, in chain order (by id when the chain is broken). */
  added: Migration[];
  /** The migrations directory's problems, as messages; any of them makes the member failed. */
  problems: string[];
}

const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The base to compare with, by the rule at the top. */
export function pullRequestBase(dir: string, env: NodeJS.ProcessEnv = process.env): BaseRef {
  if (env[BASE_ENV]) return baseRef(dir, env);
  const mr = env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  if (mr) return { ref: mr, source: "CI_MERGE_REQUEST_DIFF_BASE_SHA, the merge request's diff base" };
  return baseRef(dir, env);
}

/** The migration ids the base commit's migrations directory holds; none when it has no such directory. */
function idsAtBase(project: Project, sha: string): Set<string> {
  const rel = relative(project.dir, migrationsDir(project)).split("\\").join("/");
  let listed: string;
  try {
    listed = git(project.dir, ["ls-tree", "-d", "--name-only", `${sha}:./${rel}`]);
  } catch {
    return new Set();
  }
  return new Set(listed.split("\n").filter((l) => l !== ""));
}

/** The migrations the checkout adds over the base. */
export function addedMigrations(project: Project, env: NodeJS.ProcessEnv = process.env): AddedMigrations {
  const base = pullRequestBase(project.dir, env);
  let sha: string;
  try {
    sha = git(project.dir, ["rev-parse", "--verify", `${base.ref}^{commit}`]);
  } catch {
    throw new YodelError(
      `the pull request's migrations are the ones its base ${base.ref} (${base.source}) does not have, and this checkout does not have that commit. ` +
        `Check out the full history (fetch-depth: 0 on GitHub and Forgejo, GIT_DEPTH: "0" on GitLab), or set ${BASE_ENV}.`,
    );
  }
  const at = idsAtBase(project, sha);
  const scan = scanMigrations(migrationsDir(project));
  const chain = scan.ordered ?? scan.migrations;
  return { base, sha, added: chain.filter((m) => !at.has(m.id)), problems: scan.problems.map((p) => p.message) };
}

/** The added migrations as one change-set document. A directory problem makes the member failed, naming it. */
export function pullRequestChangeSet(project: Project, a: AddedMigrations): ChangeSetDocument {
  const part = sqlVersionedPlanPart({
    member: PULL_REQUEST_MEMBER,
    plan: {
      dialect: project.dialect,
      migrations: a.added.map((m) => ({
        id: m.id,
        steps: m.document.steps.map((step) => (step.kind === "statement" ? { ...step, sql: redact(step.sql) } : step)),
      })),
      ...(a.problems.length > 0 ? { refusal: `the migrations directory has problems: ${a.problems.join("; ")}` } : {}),
    },
  });
  return composeChangeSet([part]);
}

/** What `yodel plan --pull-request` prints: the base, and each added migration with its steps' classes. */
export function addedText(a: AddedMigrations): string {
  const lines = [`Base ${a.sha.slice(0, 12)} (${a.base.source}).`];
  if (a.added.length === 0) lines.push("The pull request adds no migration.");
  else lines.push(`The pull request adds ${String(a.added.length)} migration${a.added.length === 1 ? "" : "s"}:`);
  for (const m of a.added) {
    lines.push(`  ${m.id}`);
    for (const s of m.document.steps) {
      if (s.kind === "statement") lines.push(`    ${s.rule} ${s.class}${s.destructive ? ", destructive" : ""}  ${s.name}`);
      else lines.push(`    ${s.kind}  ${s.name}`);
    }
  }
  for (const p of a.problems) lines.push(`problem: ${p}`);
  return `${lines.join("\n")}\n`;
}
