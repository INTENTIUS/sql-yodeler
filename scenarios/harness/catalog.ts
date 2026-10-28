/**
 * sql-yodeler's scenarios on chant's e2e harness (INTENTIUS/sql-yodeler#302,
 * the sy-forge row of INTENTIUS/chant#4586): one e2e-scenario/v1 file per
 * claim and dialect, in ./scenarios/, each on the starter template of its
 * dialect.
 *
 * - sy-forge-<dialect> (claim forge): a pull request gets lint with the
 *   replay, the plan and the project's own job, all passing, and the plan
 *   comment; approved with the command the comment gives, it applies on
 *   merge; a forked migration fails lint. BREAK: merged without the
 *   approval, so the apply waits.
 * - sy-waves-<dialect> (claim waves): dev and prod are two waves of the
 *   apply pipeline, each behind its own gate. After the merge dev waits,
 *   yodel approve dev resumes it on the runner, prod waits, yodel approve
 *   prod resumes that. BREAK: the base renders the waves with gate: never,
 *   so dev never waits.
 * - sy-approval-<dialect> (claim approval, its CI half): the plan comment
 *   names the digest the gate asks for and the approval of it lets the
 *   apply run; a change that loosens its own gate still waits, since the
 *   gate is read at the base; a drop the base's policy denies fails until
 *   yodel override records an override for its digest; and yodel report
 *   finds no gap. BREAK: merged without the approval. The pre-checks half of
 *   approval stays at the engine (scenarios/claims/approval).
 *
 * The setup of each scenario (which environments the project keeps, its
 * policy, its project job) is {@link SETUPS}; the overlays its steps name
 * are scenarios/harness/overlays.ts's.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dialect } from "../lib/claim.js";
import type { Scenario } from "./harness.js";

export const scenariosDir = fileURLToPath(new URL("./scenarios/", import.meta.url));

/** How the project of a scenario is made before each arm. */
export interface Setup {
  /** The claim the scenario's row records. */
  claim: "forge" | "waves" | "approval";
  /** The waves the project keeps, in order; the template has dev and prod. */
  waves: readonly string[];
  /** The project's own job in ci/jobs.ts (yodel.config.ts ci.jobs, #65). */
  projectJob: boolean;
  /** policy.rules no-drops for dev and policy.overriders, at the base (approval's override). */
  policy: boolean;
  /** The overlays the steps name, in the order the scenario merges them; each is made on top of the ones before. */
  overlays: readonly string[];
}

export const SETUPS: Readonly<Record<string, Setup>> = {
  "sy-forge": { claim: "forge", waves: ["dev"], projectJob: true, policy: false, overlays: ["add-note", "fork"] },
  "sy-waves": { claim: "waves", waves: ["dev", "prod"], projectJob: false, policy: false, overlays: ["add-note"] },
  "sy-approval": { claim: "approval", waves: ["dev"], projectJob: false, policy: true, overlays: ["add-note", "loosen-gate", "drop-note"] },
};

export const dialectOf = (id: string): Dialect => (id.endsWith("-clickhouse") ? "ch" : "pg");

/** The setup of scenario `id` (sy-forge-clickhouse is sy-forge's). */
export function setupOf(id: string): Setup {
  const s = SETUPS[id.replace(/-(clickhouse|postgres)$/, "")];
  if (!s) throw new Error(`${id} is not one of sql-yodeler's harness scenarios (${Object.keys(SETUPS).join(", ")}, each -clickhouse and -postgres)`);
  return s;
}

/** Every scenario file, by id. */
export function readScenarios(dir = scenariosDir): Map<string, { file: string; scenario: Scenario }> {
  const out = new Map<string, { file: string; scenario: Scenario }>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const file = join(dir, f);
    const scenario = JSON.parse(readFileSync(file, "utf8")) as Scenario;
    out.set(scenario.id, { file, scenario });
  }
  return out;
}
