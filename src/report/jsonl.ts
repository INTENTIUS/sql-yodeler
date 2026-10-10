/**
 * audit.jsonl (#57): the derived audit log kept as a file, one entry per
 * line, only ever appended to. `yodel report --audit <file>` appends the
 * entries the sources hold that the file does not; `--check` appends nothing
 * and names every entry of the file that the sources no longer give, which
 * is a ledger line or a history row removed since the file was written.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { YodelError } from "../project.js";
import type { AuditEntry } from "./audit.js";

export interface AuditFile {
  path: string;
  entries: AuditEntry[];
}

export function readAuditFile(path: string): AuditFile {
  if (!existsSync(path)) return { path, entries: [] };
  const entries: AuditEntry[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        throw new YodelError(`${path}:${String(i + 1)} is not a JSON line; an audit file holds one entry per line, as yodel report --audit writes it`);
      }
      if (typeof e !== "object" || e === null || typeof (e as { id?: unknown }).id !== "string" || typeof (e as { environment?: unknown }).environment !== "string") {
        throw new YodelError(`${path}:${String(i + 1)} is not an audit entry (no id or environment)`);
      }
      entries.push(e as AuditEntry);
    });
  return { path, entries };
}

/** Compares the file with what the sources give now, for the environments read. */
export function compareAudit(file: AuditFile, derived: readonly AuditEntry[], environments: readonly string[]): { missing: AuditEntry[]; added: AuditEntry[] } {
  const now = new Set(derived.map((e) => e.id));
  const had = new Set(file.entries.map((e) => e.id));
  return {
    missing: file.entries.filter((e) => environments.includes(e.environment) && !now.has(e.id)),
    added: derived.filter((e) => !had.has(e.id)),
  };
}

export function appendAudit(path: string, entries: readonly AuditEntry[]): void {
  if (entries.length === 0) return;
  appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

/** One line for a missing entry. */
export function describeEntry(e: AuditEntry): string {
  const source = "history" in e.source ? `${e.source.history} seq ${String(e.source.seq)}` : `${e.source.ledger} (${e.source.op} / ${e.source.gate})`;
  return `${e.at} ${e.environment} ${e.kind}${e.migration ? ` ${e.migration}` : ""}${e.by ? ` by ${e.by}` : ""}${e.digest ? ` for ${e.digest}` : ""}, from ${source}`;
}
