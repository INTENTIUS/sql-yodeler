/**
 * audit.jsonl (#57, #385): the derived audit log kept as a file, one line per
 * entry in chant's `chant.audit/v1` format (`./chant-audit.ts`), only ever
 * appended to. A file written before #385 holds yodel's own entries; both
 * formats are read, through chant's `readAuditLine`, and a file may hold both.
 * `yodel report --audit <file>` appends the lines the sources hold that the
 * file does not; `--check` appends nothing and names every line of the file
 * that the sources no longer give, which is a ledger line or a history row
 * removed since the file was written.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readAuditLine } from "@intentius/chant/report-store";
import { YodelError } from "../project.js";
import { AUDIT_PRODUCT, toAuditEntry, type AuditLine } from "./chant-audit.js";
import type { AuditEntry } from "./audit.js";

export interface AuditFile {
  path: string;
  entries: AuditLine[];
}

export function readAuditFile(path: string): AuditFile {
  if (!existsSync(path)) return { path, entries: [] };
  const entries: AuditLine[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((text, i) => {
      if (text.trim() === "") return;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new YodelError(`${path}:${String(i + 1)} is not a JSON line; an audit file holds one line per entry, as yodel report --audit writes it`);
      }
      const line = readAuditLine(raw, { product: AUDIT_PRODUCT });
      if (!line || line.environment === undefined) {
        throw new YodelError(`${path}:${String(i + 1)} is not an audit line (chant.audit/v1 with an environment, or a yodel entry with an id, environment and source)`);
      }
      entries.push(line);
    });
  return { path, entries };
}

/** Compares the file with what the sources give now, for the environments read. */
export function compareAudit(file: AuditFile, derived: readonly AuditLine[], environments: readonly string[]): { missing: AuditLine[]; added: AuditLine[] } {
  const now = new Set(derived.map((e) => e.id));
  const had = new Set(file.entries.map((e) => e.id));
  return {
    missing: file.entries.filter((e) => e.environment !== undefined && environments.includes(e.environment) && !now.has(e.id)),
    added: derived.filter((e) => !had.has(e.id)),
  };
}

export function appendAudit(path: string, lines: readonly AuditLine[]): void {
  if (lines.length === 0) return;
  appendFileSync(path, lines.map((e) => `${JSON.stringify(e)}\n`).join(""));
}

/** One line for a missing entry, in yodel's words. */
export function describeEntry(line: AuditLine): string {
  const e: AuditEntry = toAuditEntry(line);
  const source = "history" in e.source ? `${e.source.history} seq ${String(e.source.seq)}` : `${e.source.ledger} (${e.source.op} / ${e.source.gate})`;
  return `${e.at} ${e.environment} ${e.kind}${e.migration ? ` ${e.migration}` : ""}${e.by ? ` by ${e.by}` : ""}${e.digest ? ` for ${e.digest}` : ""}, from ${source}`;
}
