/**
 * Promotion (#43): an environment applies only migrations the environment
 * before it recorded as applied.
 *
 * `waves[].requires` names that environment; it defaults to the wave
 * before, and `false` turns it off. Before anything is applied (and before
 * the gate), `yodel apply <env>` reads each required environment's history
 * with that environment's own profile, which outside an apply job is its
 * reader, and refuses (exit 4) any pending migration the history does not
 * record as applied with the checksum its files have now. The requirement
 * is read from the working tree's yodel.config.ts and from the base
 * commit's, and both are enforced, so a change that drops its own
 * requirement is still held to the base's.
 */

import type { WaveConfig, YodelConfig } from "../config/define.js";
import { loadYodelConfigAtBase } from "../config/base.js";
import { EXIT_REFUSED } from "../exit.js";
import type { Migration } from "../migrations/index.js";
import { resolveEnvironment, YodelError, type Project } from "../project.js";
import { closeVersioned, inspect, openVersioned } from "../versioned/engine.js";
import type { PendingMigration } from "../versioned/state.js";

/** The environment `env` requires in `config`: `requires`, else the wave before; undefined for none. */
export function requiredIn(config: YodelConfig | undefined, env: string): string | undefined {
  const waves: readonly WaveConfig[] = config?.waves ?? [];
  const i = waves.findIndex((w) => w.env === env);
  const wave = waves[i];
  if (!wave || wave.requires === false) return undefined;
  return wave.requires ?? waves[i - 1]?.env;
}

/** Each required environment and where the requirement comes from: the working tree, the base commit, or both. */
export async function requiredEnvironments(project: Project, env: string): Promise<Array<{ env: string; from: string }>> {
  const out = new Map<string, string[]>();
  const add = (e: string | undefined, from: string) => {
    if (e && e !== env) out.set(e, [...(out.get(e) ?? []), from]);
  };
  add(requiredIn(project.yodel?.config, env), "yodel.config.ts");
  try {
    const at = await loadYodelConfigAtBase(project.dir);
    add(requiredIn(at.config, env), `yodel.config.ts at ${at.sha.slice(0, 12)}`);
  } catch {
    // No git, or no base commit (a repository's first commit): the working tree's requirement alone.
  }
  return [...out].map(([e, from]) => ({ env: e, from: from.join(" and ") }));
}

/** What one required environment's history says of each pending migration. */
export interface Promotion {
  /** The required environment. */
  env: string;
  from: string;
  migrations: Array<{ id: string; checksum: string; ran: "applied" | "not applied" | "applied with another checksum"; recorded?: string }>;
}

/** Reads each required environment's history for `pending`. */
export async function readPromotions(project: Project, env: string, ordered: readonly Migration[], pending: ReadonlyArray<Pick<PendingMigration, "id" | "checksum">>): Promise<Promotion[]> {
  const out: Promotion[] = [];
  for (const req of await requiredEnvironments(project, env)) {
    let environment;
    try {
      environment = resolveEnvironment(project, req.env);
    } catch (e) {
      throw new YodelError(`refused: ${env} requires ${req.env} (${req.from}), and ${e instanceof Error ? e.message : String(e)}; nothing was applied`, EXIT_REFUSED);
    }
    const venv = await openVersioned(project, environment);
    try {
      const { status } = await inspect(venv, ordered, { sync: false });
      const applied = new Map(status.applied.map((a) => [a.id, a.checksum]));
      out.push({
        env: req.env,
        from: req.from,
        migrations: pending.map((p) => {
          const recorded = applied.get(p.id);
          if (recorded === undefined) return { id: p.id, checksum: p.checksum, ran: "not applied" };
          return recorded === p.checksum ? { id: p.id, checksum: p.checksum, ran: "applied" } : { id: p.id, checksum: p.checksum, ran: "applied with another checksum", recorded };
        }),
      });
    } finally {
      await closeVersioned(venv);
    }
  }
  return out;
}

/** The refusal for the promotions, or undefined when every pending migration ran where it had to. */
export function promotionRefusal(env: string, promotions: readonly Promotion[]): YodelError | undefined {
  const lines = promotions.flatMap((p) =>
    p.migrations
      .filter((m) => m.ran !== "applied")
      .map((m) => `  ${m.id}: ${m.ran === "not applied" ? `${p.env}'s history does not record it applied` : `${p.env} applied it with checksum ${m.recorded ?? "?"}, and its files now hash to ${m.checksum}`} (required by ${p.from})`),
  );
  if (lines.length === 0) return undefined;
  const envs = [...new Set(promotions.filter((p) => p.migrations.some((m) => m.ran !== "applied")).map((p) => p.env))];
  return new YodelError(
    `refused: ${env} applies only migrations ${envs.join(" and ")} applied first, and ${String(lines.length)} pending ${lines.length === 1 ? "one has" : "ones have"} not run there:\n${lines.join("\n")}\n` +
      `Nothing was applied. Apply ${lines.length === 1 ? "it" : "them"} to ${envs.join(" and ")} first.`,
    EXIT_REFUSED,
  );
}

/** Reads the required environments and throws the refusal when a pending migration has not run there. */
export async function enforcePromotion(project: Project, env: string, ordered: readonly Migration[], pending: ReadonlyArray<Pick<PendingMigration, "id" | "checksum">>): Promise<Promotion[]> {
  if (pending.length === 0) return [];
  const promotions = await readPromotions(project, env, ordered, pending);
  const refusal = promotionRefusal(env, promotions);
  if (refusal) throw refusal;
  return promotions;
}

/** What the wave plan digest takes of the promotions: each required environment and the pending migrations' checksums it recorded. */
export const promotionEvidence = (promotions: readonly Promotion[]) =>
  promotions.map((p) => ({ env: p.env, applied: p.migrations.filter((m) => m.ran === "applied").map((m) => ({ id: m.id, checksum: m.checksum })) }));
