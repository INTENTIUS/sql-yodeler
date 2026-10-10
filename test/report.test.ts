/**
 * yodel report (#57): the audit log derived from fixed history rows and
 * ledger lines; a history row or a ledger line removed shows up as a gap,
 * and as an entry an audit.jsonl written earlier no longer finds; the
 * report across environments; the JSON against its schema, and every field
 * docs/audit.md describes in the schema.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { reportJson } from "../src/commands/report.js";
import type { HistoryRow } from "../src/history/index.js";
import type { Migration } from "../src/migrations/index.js";
import type { Project } from "../src/project.js";
import { deriveAudit, type AuditEntry, type LedgerInput } from "../src/report/audit.js";
import { appendAudit, compareAudit, readAuditFile } from "../src/report/jsonl.js";
import { collectReport, type ReportSources } from "../src/report/model.js";
import { renderReportHtml, renderReportText } from "../src/report/render.js";
import { readSchema, schemaId } from "../src/schemas.js";
import { repoRoot, yodel } from "./helpers/run.js";

const D1 = "jcs1-sha256:1111";
const D2 = "jcs1-sha256:2222";

let seq = 0;
function row(r: Partial<HistoryRow> & Pick<HistoryRow, "migration_id" | "status">): HistoryRow {
  seq += 1;
  return {
    seq,
    run_id: "run-1",
    kind: "migration",
    parent: "",
    checksum: "sha256:c",
    statement_index: -1,
    statement_sha: "",
    error: "",
    applied_by: "ci@host",
    plan_digest: D1,
    silences: "[]",
    note: "",
    recorded_at: `2026-10-10 09:00:${String(seq).padStart(2, "0")}.000000`,
    ...r,
  };
}

/** Two migrations: the first applied under D1 with a silence; the second refused by a check, then applied under D2, then repaired. */
function rows(): HistoryRow[] {
  seq = 0;
  return [
    row({ migration_id: "m1", status: "started", silences: JSON.stringify([{ step: 0, rule: "destructive", reason: "TICKET-1" }]) }),
    row({ migration_id: "m1", kind: "statement", statement_index: 0, status: "succeeded" }),
    row({ migration_id: "m1", status: "succeeded" }),
    row({ migration_id: "m2", parent: "m1", status: "started", plan_digest: D2, run_id: "run-2" }),
    row({ migration_id: "m2", parent: "m1", status: "failed", plan_digest: D2, run_id: "run-2", error: "check table-empty failed: 1 row" }),
    row({ migration_id: "m2", parent: "m1", status: "started", plan_digest: D2, run_id: "run-3" }),
    row({ migration_id: "m2", parent: "m1", kind: "statement", statement_index: 0, status: "succeeded", plan_digest: D2, run_id: "run-3" }),
    row({ migration_id: "m2", parent: "m1", status: "succeeded", plan_digest: D2, run_id: "run-3" }),
    row({ migration_id: "m2", parent: "m1", status: "succeeded", plan_digest: D2, run_id: "run-4", applied_by: "bob@laptop", note: "whitespace only", checksum: "sha256:new" }),
  ];
}

function ledger(): LedgerInput {
  return {
    op: "migrate-dev",
    gate: "approve-migrate-dev",
    path: "_gates/migrate-dev.jsonl",
    pending: [
      { gate: "approve-migrate-dev", timestamp: "2026-10-10T08:59:00.000Z", planDigest: D1, runId: "r1" },
      { gate: "approve-migrate-dev", timestamp: "2026-10-10T09:00:03.500Z", planDigest: D2, runId: "r2" },
    ],
    resolutions: [
      { gate: "approve-migrate-dev", timestamp: "2026-10-10T08:59:30.000Z", resolvedBy: "alice", planDigest: D1 },
      { gate: "approve-migrate-dev", timestamp: "2026-10-10T09:00:04.000Z", resolvedBy: "alice", planDigest: D2 },
      { gate: "override-no-drops", timestamp: "2026-10-10T09:00:04.500Z", resolvedBy: "alice", planDigest: D2, note: "nothing reads it" },
      { gate: "some-other-gate", timestamp: "2026-10-10T09:00:05.000Z", resolvedBy: "eve" },
    ],
  };
}

const derive = (r: HistoryRow[] = rows(), l: LedgerInput | undefined = ledger()) => deriveAudit({ environment: "dev", history: "yodeler.history", rows: r, ledger: l });
const kinds = (entries: AuditEntry[]) => entries.map((e) => `${e.kind}${e.migration ? ` ${e.migration}` : ""}`);

describe("the audit log", () => {
  it("is derived from the history and the ledger, oldest first, with no gap", () => {
    const { entries, gaps } = derive();
    expect(gaps).toEqual([]);
    expect(kinds(entries)).toEqual([
      "approval-requested",
      "approved",
      "silenced m1",
      "applied m1",
      "approval-requested",
      "approved",
      "override",
      "refused m2",
      "applied m2",
      "repaired m2",
    ]);
    const override = entries.find((e) => e.kind === "override");
    expect(override).toMatchObject({ by: "alice", digest: D2, detail: "no-drops: nothing reads it", source: { ledger: "_gates/migrate-dev.jsonl", op: "migrate-dev", gate: "override-no-drops" } });
    expect(entries.find((e) => e.kind === "applied" && e.migration === "m1")).toMatchObject({ at: "2026-10-10T09:00:03.000000Z", by: "ci@host", digest: D1, source: { history: "yodeler.history", seq: 3, run: "run-1" } });
    expect(entries.find((e) => e.kind === "repaired")).toMatchObject({ by: "bob@laptop", detail: "whitespace only" });
    expect(entries.find((e) => e.kind === "silenced")?.detail).toBe("step 0: destructive TICKET-1");
  });

  it("gives the same ids from the same sources", () => {
    expect(derive().entries.map((e) => e.id)).toEqual(derive().entries.map((e) => e.id));
    expect(new Set(derive().entries.map((e) => e.id)).size).toBe(derive().entries.length);
  });

  it("names a removed history row as a gap", () => {
    const all = rows();
    const { gaps } = derive(all.filter((r) => r.seq !== 5));
    expect(gaps).toEqual([{ environment: "dev", kind: "history-row", detail: "yodeler.history has no row with seq 5 of 1..9: rows are only ever appended, so that row was deleted" }]);
  });

  it("names a removed approval line as a gap: a migration applied under a digest the ledger does not approve", () => {
    const l = ledger();
    const { gaps } = derive(rows(), { ...l, resolutions: l.resolutions.filter((r) => r.planDigest !== D2 || r.gate !== l.gate) });
    expect(gaps).toEqual([{ environment: "dev", kind: "approval", detail: `m2 was applied under ${D2} (yodeler.history seq 8), but _gates/migrate-dev.jsonl holds no approval of migrate-dev / approve-migrate-dev for that digest` }]);
  });

  it("needs no approval for a baseline, and checks none without a ledger", () => {
    seq = 0;
    expect(derive([row({ migration_id: "base", status: "succeeded", plan_digest: "", note: "baseline" })]).gaps).toEqual([]);
    expect(derive(rows(), undefined).gaps).toEqual([]);
  });
});

describe("audit.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-audit-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends only what it does not have, and --check names an entry whose ledger line or history row was removed", () => {
    const path = join(dir, "audit.jsonl");
    const full = derive().entries;
    appendAudit(path, compareAudit(readAuditFile(path), full, ["dev"]).added);
    expect(readAuditFile(path).entries).toHaveLength(full.length);
    // Again: nothing new.
    expect(compareAudit(readAuditFile(path), full, ["dev"])).toEqual({ missing: [], added: [] });
    const lines = readFileSync(path, "utf8");

    // A pending line removed from the ledger.
    const l = ledger();
    const noPending = derive(rows(), { ...l, pending: l.pending.slice(1) }).entries;
    expect(kinds(compareAudit(readAuditFile(path), noPending, ["dev"]).missing)).toEqual(["approval-requested"]);
    // A history row removed.
    const noRow = derive(rows().filter((r) => r.seq !== 5)).entries;
    expect(compareAudit(readAuditFile(path), noRow, ["dev"]).missing.map((e) => e.detail)).toEqual(["check table-empty failed: 1 row"]);
    // An environment not read is not compared.
    expect(compareAudit(readAuditFile(path), [], ["prod"]).missing).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(lines);
  });
});

const chain = [{ id: "m1" }, { id: "m2" }, { id: "m3" }] as unknown as Migration[];
const project = { dir: "/work/shop", dialect: "clickhouse", config: {}, configPath: "/work/shop/chant.config.ts", sourceDir: "src" } as unknown as Project;
const port = (l: LedgerInput): GateLedgerPort => ({
  read: () => Promise.resolve({ pending: l.pending.map((p) => ({ version: 1, kind: "pending", op: l.op, expiresAt: "", ...p })), resolutions: l.resolutions.map((r) => ({ version: 1, op: l.op, ...r })) }) as ReturnType<GateLedgerPort["read"]>,
  appendPending: () => Promise.reject(new Error("read only")),
});
const sources: ReportSources = {
  rows: (_p, env) => (env === "prod" ? Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:8123")) : Promise.resolve({ rows: env === "dev" ? rows() : rows().slice(0, 3), history: `yodel_${env}.history` })),
  op: (_p, env) => Promise.resolve({ name: `migrate-${env}`, gate: `approve-migrate-${env}`, filePath: "", quorum: false }),
  ledger: () => Promise.resolve(port(ledger())),
};

describe("the report across environments", async () => {
  // staging's ledger is read for migrate-staging, but the fixture ledger is dev's: its gate does not match, so m1 there has no approval.
  const r = await collectReport(project, chain, ["dev", "staging", "prod"], sources, new Date("2026-10-10T12:00:00Z"));

  it("shows each migration's state in each environment, and who approved it", () => {
    expect(r.migrations).toEqual(["m1", "m2", "m3"]);
    const dev = r.environments[0];
    expect(dev?.migrations.map((m) => `${m.id}:${m.state}`)).toEqual(["m1:applied", "m2:applied", "m3:pending"]);
    expect(dev?.migrations[1]).toMatchObject({ digest: D2, approvedBy: "alice", approvedAt: "2026-10-10T09:00:04.000Z", by: "ci@host" });
    expect(r.environments[1]?.migrations.map((m) => m.state)).toEqual(["applied", "pending", "pending"]);
    expect(r.environments[2]).toMatchObject({ name: "prod", error: "the history could not be read: connect ECONNREFUSED 10.0.0.9:8123", migrations: [] });
    expect(r.gaps.map((g) => `${g.environment}:${g.kind}`)).toEqual(["staging:approval"]);
  });

  it("renders as text and as a self-contained page", () => {
    const text = renderReportText(r);
    expect(text).toContain("migration  dev                       staging                   prod");
    expect(text).toContain("m3         pending                   pending                   unread");
    expect(text).toContain("prod: the history could not be read");
    const html = renderReportHtml({ ...r, project: "<script>" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|src=|href=/);
    expect(html).toContain("&lt;script&gt;");
  });

  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addSchema(readSchema("report"));
  const validate = ajv.getSchema(schemaId("report"));

  it("validates against schemas/report.schema.json, with and without the audit file", () => {
    for (const doc of [reportJson(r), reportJson(r, { path: "audit.jsonl", appended: 3, missing: r.audit.slice(0, 1) })]) {
      expect(validate?.(JSON.parse(JSON.stringify(doc))), JSON.stringify(validate?.errors)).toBe(true);
    }
  });

  it("has every field docs/audit.md describes, and the docs describe every field", () => {
    const schema = readSchema("report") as { properties: Record<string, unknown>; $defs: Record<string, unknown> };
    const deref = (s: unknown): Record<string, unknown> => {
      const o = s as Record<string, unknown>;
      if (typeof o.$ref === "string") return deref(schema.$defs[o.$ref.replace("#/$defs/", "")]);
      return o;
    };
    const fields = (s: unknown, prefix: string): string[] => {
      const o = deref(s);
      if (o.type === "array") return fields(o.items, `${prefix}[]`);
      const props = o.properties as Record<string, unknown> | undefined;
      if (!props) return [];
      return Object.entries(props).flatMap(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        const inner = deref(v);
        // audit[].source is one of two shapes; the docs describe it as a whole.
        if (k === "source" || k === "op" || path === "auditFile.missing") return [path];
        return [path, ...fields(inner, path)];
      });
    };
    const inSchema = fields(schema, "").map((p) => p.replace(/\.\[\]/g, "[]"));
    const page = readFileSync(join(repoRoot, "docs", "audit.md"), "utf8");
    const table = page.slice(page.indexOf("| Field | What it holds |"));
    const documented = [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1] ?? "");
    expect(documented.length).toBeGreaterThan(20);
    expect(documented.filter((f) => !inSchema.includes(f)), "documented, not in the schema").toEqual([]);
    expect(inSchema.filter((f) => !documented.includes(f)), "in the schema, not documented").toEqual([]);
  });
});

describe("yodel report's arguments", () => {
  it("refuses --check without --audit", async () => {
    const ran = await yodel(["report", "--check"]);
    expect(ran.code).toBe(1);
    expect(ran.err).toMatch(/--check checks an audit file: give it with --audit <file>/);
  });
});
