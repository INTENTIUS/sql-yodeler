/**
 * Rule levels from `yodel.config.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   lint: { rules: { "ch-mutation": "warning", "pg-lock": "off" } },
 * });
 * ```
 *
 * A level is `error` (fails the run), `warning` (reported, does not fail)
 * or `off`. The integrity rules (`fork`, `directory`, `checksum`,
 * `unreadable-object`) are always errors and cannot be set.
 */

import { YodelError } from "../project.js";
import type { LevelSetting, LintRule } from "./rules.js";

export interface LintSettings {
  levels: Record<string, LevelSetting>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LEVELS: readonly string[] = ["error", "warning", "off"];

/** Checks `lint` from `yodel.config.ts` against the rules there are. `where` names the file in errors. */
export function lintSettings(raw: Record<string, unknown> | undefined, rules: Readonly<Record<string, LintRule>>, where = "yodel.config.ts"): LintSettings {
  const levels: Record<string, LevelSetting> = {};
  if (raw === undefined) return { levels };
  for (const k of Object.keys(raw)) if (k !== "rules") throw new YodelError(`${where}: lint.${k}: unknown setting (expected rules)`);
  if (raw.rules === undefined) return { levels };
  if (!isRecord(raw.rules)) throw new YodelError(`${where}: lint.rules: expected an object of rule: "error" | "warning" | "off"`);
  for (const [id, level] of Object.entries(raw.rules)) {
    const rule = rules[id];
    if (!rule) throw new YodelError(`${where}: lint.rules.${id}: no such rule (the rules: ${Object.keys(rules).join(", ")})`);
    if (typeof level !== "string" || !LEVELS.includes(level)) throw new YodelError(`${where}: lint.rules.${id}: expected "error", "warning" or "off"`);
    if (!rule.configurable && level !== "error") throw new YodelError(`${where}: lint.rules.${id}: ${id} is an integrity rule and is always an error`);
    levels[id] = level as LevelSetting;
  }
  return { levels };
}

/** The level a rule runs at. */
export const levelOf = (rule: LintRule, settings: LintSettings | undefined): LevelSetting => settings?.levels[rule.id] ?? rule.level;
