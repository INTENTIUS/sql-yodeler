/**
 * The project-wide rules `yodel lint` runs after its own: rules that need
 * more than the migrations directory, such as a server or the emulator.
 *
 * {@link projectRules} run on every lint. The replay check (#11,
 * `../replay/`) runs only with `yodel lint --replay <env>`, because it needs
 * a throwaway server: the command replays the history first (so a target
 * that is not fresh refuses with the replay's own exit code, 4) and hands
 * the result to {@link replayRule}, which turns a failure into a finding of
 * rule `replay`. Its level comes from `yodel.config.ts` (`lint.rules.replay`)
 * like a built-in rule's.
 */

import { replayFailure, type ReplayResult } from "../replay/index.js";
import type { ProjectRule } from "./check.js";
import type { LintRule } from "./rules.js";

export const projectRules: readonly ProjectRule[] = [];

export const REPLAY_RULE: LintRule = {
  id: "replay",
  summary: "with --replay <env>: the history, replayed into a fresh database, does not give each migration's recorded schema",
  level: "error",
  silenceable: false,
  configurable: true,
};

/** The replay's result as a rule: one finding naming the first migration that fails, or none. */
export function replayRule(result: ReplayResult): ProjectRule {
  return {
    rule: REPLAY_RULE,
    check: () => {
      const failure = replayFailure(result);
      return Promise.resolve(failure ? [{ rule: REPLAY_RULE.id, migration: failure.migration, message: failure.message }] : []);
    },
  };
}
