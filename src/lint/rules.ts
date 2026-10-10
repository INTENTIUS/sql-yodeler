/**
 * `yodel lint`'s rules: what each checks, its level unless `yodel.config.ts`
 * sets another, and whether a statement can silence it.
 *
 * Two kinds:
 *
 * - Integrity rules, over the directory and each migration as a whole:
 *   `fork`, `directory`, `checksum`, `unreadable-object`, `checkpoint`. Always errors; no
 *   config lowers them and nothing silences them, because a migration that
 *   breaks one cannot be applied safely or cannot be checked at all.
 * - Statement rules, from the classes chant's classifier gives each step:
 *   `destructive`, `pg-rewrite`, `pg-lock`, `pg-signature`, `pg-access`,
 *   `pg-rls-not-forced` (a warning), `ch-mutation`, `ch-rebuild`.
 *   Errors by default; a line `-- yodel:allow <rule> <reason>` above the
 *   statement in `migration.sql` silences one for that statement, and the
 *   reason is recorded in the history when the migration applies.
 *
 * The rest (`refused-step`, `pg-routine-in-use`, `migration-sql`,
 * `silence`) say a migration will not apply as written or a silence is
 * wrong. Their level can be
 * changed in `yodel.config.ts`, but they cannot be silenced.
 */

export type LintLevel = "error" | "warning";
export type LevelSetting = LintLevel | "off";

export interface LintRule {
  id: string;
  /** One line, for `yodel lint --rules` and the docs. */
  summary: string;
  level: LintLevel;
  /** A `-- yodel:allow <id> <reason>` line can silence it for one statement. */
  silenceable: boolean;
  /** `yodel.config.ts` `lint.rules` may change its level. */
  configurable: boolean;
  /** The dialect it applies to; both when absent. */
  dialect?: "clickhouse" | "postgres";
}

const integrity = (id: string, summary: string): LintRule => ({ id, summary, level: "error", silenceable: false, configurable: false });
const statement = (id: string, summary: string, dialect?: LintRule["dialect"]): LintRule => ({ id, summary, level: "error", silenceable: true, configurable: true, ...(dialect ? { dialect } : {}) });
const shape = (id: string, summary: string, level: LintLevel = "error"): LintRule => ({ id, summary, level, silenceable: false, configurable: true });

export const LINT_RULES = {
  fork: integrity("fork", "two migrations follow the same parent; rebase one onto the other (yodel rebase)"),
  directory: integrity("directory", "the migrations directory is not one readable chain: a bad name or file, a missing parent, a cycle, another dialect"),
  checksum: integrity("checksum", "a migration's files no longer hash to its checksum: an edit after it was written, or (with --env) after it was applied"),
  "unreadable-object": integrity("unreadable-object", "an object in a recorded schema, or a step, the sql lexicon cannot read or classify; never skipped"),
  checkpoint: integrity("checkpoint", "a checkpoint whose recorded schema is no longer the one it was written from, its parent's, or that holds a step other than a statement"),
  destructive: statement("destructive", "a statement or Op step removes data that cannot be recovered (a table or column drop)"),
  "pg-rewrite": statement("pg-rewrite", "Postgres: rewrites or scans the whole table under ACCESS EXCLUSIVE, blocking reads and writes while it runs", "postgres"),
  "pg-lock": statement("pg-lock", "Postgres: holds a lock that blocks writes for a whole scan or index build (an index without CONCURRENTLY, a constraint validated in place)", "postgres"),
  "pg-signature": statement("pg-signature", "Postgres: a function or procedure dropped and created with another signature or result; a caller written for the old one fails", "postgres"),
  "pg-routine-in-use": { id: "pg-routine-in-use", summary: "Postgres: a function dropped while a trigger the migration's schema declares still executes it; the DROP fails", level: "error", silenceable: false, configurable: true, dialect: "postgres" },
  "pg-access": statement("pg-access", "Postgres: takes access away: a privilege revoked, a policy dropped, or row-level security turned off or no longer forced on the table's owner", "postgres"),
  "pg-rls-not-forced": { id: "pg-rls-not-forced", summary: "Postgres: a table's row-level security is enabled but not forced, so the table's owner (often the role that applies) bypasses its policies", level: "warning", silenceable: true, configurable: true, dialect: "postgres" },
  "ch-mutation": statement("ch-mutation", "ClickHouse: starts a mutation that rewrites existing parts in the background, with no rollback", "clickhouse"),
  "ch-rebuild": statement("ch-rebuild", "ClickHouse: a rebuild, every row copied into a new table and swapped in (ClickHouseRebuildOp)", "clickhouse"),
  "refused-step": shape("refused-step", "a step yodel apply refuses to run: a manual step, or an Op step it does not run"),
  "migration-sql": shape("migration-sql", "migration.sql does not hold a statement as migration.json records it; apply runs migration.json's"),
  silence: shape("silence", "a yodel:allow line that is malformed, names a rule no statement can silence, has no reason, or silences nothing"),
} as const satisfies Record<string, LintRule>;

export type LintRuleId = keyof typeof LINT_RULES;

export const ruleIds = Object.keys(LINT_RULES) as LintRuleId[];

export const isRuleId = (id: string): id is LintRuleId => Object.hasOwn(LINT_RULES, id);

/** The rules a `-- yodel:allow` line can name. */
export const silenceableRules = (): LintRuleId[] => ruleIds.filter((id) => LINT_RULES[id].silenceable);
