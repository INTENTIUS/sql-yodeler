/**
 * A project's own rules (#227) inside `yodel lint`: the checks
 * `chant.config.ts` `lint.policies` names, which `chant build` and
 * `chant lint` run over the declared schema, run here on each migration's
 * recorded schema beside the lexicon's schema checks. A check reads the
 * parsed objects through `@intentius/chant-lexicon-sql/read`, so a rule such
 * as "every table has created_at timestamptz NOT NULL" is a few lines.
 *
 * Each check's id is a lint rule: silenceable with `-- yodel:allow <id>`,
 * its level set in `yodel.config.ts` `lint.rules`, else `chant.config.ts`
 * `lint.rules`, else the level the check gives each finding.
 */

import { dirname } from "node:path";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { YodelError, type Project } from "../project.js";
import type { LintRule } from "./rules.js";

/** The paths `chant.config.ts` `lint.policies` names, relative to the config. */
export function policyPaths(project: Project): string[] {
  const raw = (project.config as { lint?: { policies?: unknown } }).lint?.policies;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((p): p is string => typeof p === "string")) throw new YodelError(`${project.configPath}: lint.policies: expected a list of module paths`);
  return raw;
}

/** Loads the project's policy checks, with chant's own loader, so `chant lint` and `yodel lint` run the same ones. */
export async function loadPolicies(project: Project): Promise<PostSynthCheck[]> {
  const paths = policyPaths(project);
  if (paths.length === 0) return [];
  const { loadPolicyChecks } = await import("@intentius/chant/lint/policy");
  try {
    return await loadPolicyChecks(paths, dirname(project.configPath));
  } catch (e) {
    throw new YodelError(`${project.configPath}: lint.policies: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A policy check as a lint rule, so `lint.rules`, `--rules` and `-- yodel:allow` know it. */
export const policyRule = (check: PostSynthCheck): LintRule => ({
  id: check.id,
  summary: `project policy: ${check.description}`,
  level: "warning",
  silenceable: true,
  configurable: true,
  schema: true,
});

export const policyRules = (checks: readonly PostSynthCheck[]): Record<string, LintRule> => Object.fromEntries(checks.map((c) => [c.id, policyRule(c)]));
