/**
 * `yodel.config.ts`: what yodel needs per environment that chant's
 * `chant.config.ts` does not say. Optional; a project without one runs on
 * the defaults below.
 *
 * ```ts
 * // yodel.config.ts
 * import { defineConfig } from "@intentius/sql-yodeler";
 *
 * export default defineConfig({
 *   environments: {
 *     dev: { topology: "single" },
 *     prod: { topology: "cluster:main", history: { database: "yodeler" }, lockTtl: 1800 },
 *   },
 * });
 * ```
 */

import type { Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";

import type { LevelSetting, LintRuleId } from "../lint/rules.js";

export type { Topology };

/**
 * A ClickHouse topology in its string form (`single`, `cluster:<name>`,
 * `replicated`, `replicated:<cluster>`, `cloud`) or chant's object form,
 * which also sets a cluster's Keeper path and replica name for the tables
 * the migrations create.
 */
export type TopologySetting = string | Topology;

export interface EnvironmentConfig {
  /**
   * The ClickHouse topology this environment runs. Every statement of every
   * migration is rendered for it when it is sent (`ON CLUSTER`, the
   * replicated engine), and the history table's engine follows it.
   * Default: `sql.profiles.<env>.topology` in chant.config.ts, then
   * `YODEL_TOPOLOGY`, then `single`.
   */
  topology?: TopologySetting;
  history?: {
    /** The database the history and lock tables live in. Default: `YODEL_HISTORY_DATABASE`, then `yodeler`. */
    database?: string;
  };
  /** The apply lock's TTL, in seconds. Default: `YODEL_LOCK_TTL`, then 900. */
  lockTtl?: number;
}

export interface YodelConfig {
  /** Keyed by the environment's name in `sql.profiles`. */
  environments?: Record<string, EnvironmentConfig>;
  /** `yodel lint`'s rule levels: `{ rules: { destructive: "warning" } }`. A misspelled rule name is a type error. */
  lint?: LintConfig;
}

/** The rules `lint.rules` can set: every lint rule, and the replay check's. */
export type LintRuleName = LintRuleId | "replay";

export interface LintConfig {
  /** Each rule's level. The integrity rules (fork, directory, checksum, unreadable-object) are always errors. */
  rules?: Partial<Record<LintRuleName, LevelSetting>>;
}

/** Returns `config` as is; it types the default export of `yodel.config.ts`. */
export const defineConfig = (config: YodelConfig): YodelConfig => config;
