/**
 * The replay check's result for people (text) and for tools (JSON), and its
 * exit code.
 */

import { MIGRATIONS_DIR, MIGRATION_JSON, MIGRATION_SQL } from "../migrations/index.js";
import { type ReplayChange, type ReplayResult } from "./replay.js";
import { EXIT_WAITING } from "../exit.js";

/** 0 when every migration replays to its recorded schema; 1 for a difference or a statement the server refused; 2 for a step the replay cannot run. */
export function replayExitCode(result: ReplayResult): number {
  if (result.outcome === "matches") return 0;
  if (result.outcome === "unreplayable") return EXIT_WAITING;
  return 1;
}

const shown = (v: string | undefined): string => (v === undefined ? "(absent)" : v);

/** One difference: the object, the field, and the replay's value against the record's. */
export function describeChange(c: ReplayChange): string {
  return `${c.object}: ${c.field}: replay has ${shown(c.before)}, ${MIGRATION_JSON} records ${shown(c.after)} (${c.rule})`;
}

/** The failure in one paragraph, naming the first migration that fails; `undefined` when the replay matched. For `yodel lint`. */
export function replayFailure(result: ReplayResult): { migration: string; message: string } | undefined {
  const before = result.matched.length > 0 ? ` The ${String(result.matched.length)} migration${result.matched.length === 1 ? "" : "s"} before it replayed to ${result.matched.length === 1 ? "its" : "their"} recorded schema${result.matched.length === 1 ? "" : "s"}.` : "";
  switch (result.outcome) {
    case "matches":
      return undefined;
    case "differs": {
      const m = result.migration;
      const n = result.changes.length;
      const skipped = m.skipped.length > 0 ? `\nSteps not replayed: ${m.skipped.join("; ")}.` : "";
      return {
        migration: m.id,
        message:
          `${m.id}: replaying the history through it does not give the schema it records (${MIGRATIONS_DIR}/${m.id}/${MIGRATION_JSON}); ${String(n)} difference${n === 1 ? "" : "s"}:\n` +
          result.changes.map((c) => `  ${describeChange(c)}`).join("\n") +
          `\n${before.trim() ? `${before.trim()}\n` : ""}` +
          (m.handWritten
            ? `It is hand-written, and it records the build of src/ as the schema after it: declare in src/ what its statements change (or change the statements), then run yodel lint --update-checksum ${m.id} again.${skipped}`
            : `Its statements (the steps in ${MIGRATION_JSON}, which ${MIGRATION_SQL} shows) and its recorded schema disagree: make the statements produce the schema, or record the schema they produce, then yodel repair the migration where it is already applied.${skipped}`),
      };
    }
    case "failed":
      return {
        migration: result.migration,
        message: `${result.migration}: statement ${String(result.step)} failed in the replay: ${result.error}.${before} The history does not apply to an empty database as written.`,
      };
    case "unreplayable":
      return {
        migration: result.migration,
        message: `${result.migration}: step ${String(result.step)} cannot be replayed: ${result.reason}.${before} The migrations from it on are not checked.`,
      };
  }
}

/** The result as text. */
export function renderReplay(result: ReplayResult): string {
  const lines = [`Replay of ${String(result.total)} migration${result.total === 1 ? "" : "s"} (${result.dialect}) into ${result.where}`];
  if (result.scope.length > 0) lines.push(`  ${result.dialect === "postgres" ? "schemas" : "databases"}: ${result.scope.join(", ")}${result.reset ? " (emptied first)" : ""}${result.kept ? " (left in place)" : ""}`);
  for (const m of result.matched) {
    const extra = [...m.ran.map((r) => `ran ${r}`), ...m.skipped.map((s) => `skipped ${s}`)];
    lines.push(`  ok      ${m.id} (${String(m.statements)} statement${m.statements === 1 ? "" : "s"}${m.checkpoint ? ", a checkpoint, from an empty database" : ""}${extra.length > 0 ? `; ${extra.join("; ")}` : ""})`);
  }
  const failure = replayFailure(result);
  if (!failure) {
    lines.push(result.total === 0 ? "No migrations to replay." : "Every migration replays to its recorded schema.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(`  ${result.outcome.padEnd(7)} ${failure.migration}`, "", failure.message);
  return `${lines.join("\n")}\n`;
}

/** The result as JSON. */
export function replayJson(result: ReplayResult): Record<string, unknown> {
  const failure = replayFailure(result);
  return { ...result, ok: result.outcome === "matches", ...(failure ? { message: failure.message } : {}) };
}
