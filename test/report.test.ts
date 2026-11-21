/**
 * yodel report (#57): the audit log derived from fixed history rows and
 * ledger lines; a history row or a ledger line removed shows up as a gap,
 * and as an entry an audit.jsonl written earlier no longer finds; the
 * report across environments; the JSON against its schema, and every field
 * docs/audit.md describes in the schema.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";
import type { GateLedgerPort } from "@intentius/chant/op/gate";
import { overridePending } from "@intentius/chant/override-gate";
import { HAT_ICON, HAT_IMG } from "../src/brand.js";
import { reportJson } from "../src/commands/report.js";
import type { HistoryRow } from "../src/history/index.js";
import type { Migration } from "../src/migrations/index.js";
import type { Project } from "../src/project.js";
import { readAuditLine, toProductAuditLine } from "@intentius/chant/report-store";
import chantAuditSchema from "@intentius/chant/report-store/audit.schema.json" with { type: "json" };
import { AUDIT_KINDS, deriveAudit, type AuditEntry, type LedgerInput } from "../src/report/audit.js";
import { toAuditEntry, toAuditLines, type AuditLine } from "../src/report/chant-audit.js";
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

/** An op's ledger lines, short: the pending facts and the resolutions. */
interface Lines {
  pending: Array<{ gate: string; timestamp: string; planDigest?: string; runId?: string }>;
  resolutions: Array<{ gate: string; timestamp: string; resolvedBy: string; planDigest?: string; note?: string }>;
}

/** The records a GateLedgerPort reads for `op`'s `lines`. */
const records = (op: string, l: Lines) => ({ pending: l.pending.map((p) => ({ version: 1, kind: "pending", op, expiresAt: "", ...p })), resolutions: l.resolutions.map((r) => ({ version: 1, op, ...r })) });

/** `l` as chant's reader (readGateAuditLedgers) gives it. */
const linesOf = (op: string, l: Lines) => {
  const r = records(op, l);
  return [...r.pending, ...r.resolutions].map((record) => ({ record }));
};

function devLines(): Lines {
  return {
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

function ledger(l: Lines = devLines()): LedgerInput {
  return { op: "migrate-dev", gate: "approve-migrate-dev", path: "_gates/migrate-dev.jsonl", lines: linesOf("migrate-dev", l) };
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

  it("shows the overrides on chant's override gate of the migrations Op's plans and reverts, with the rules and plan of the denial each answers", () => {
    const answer = (subject: string, plan: string, rules: string[], at: string, note: string) => {
      const denial = overridePending({ subject, planDigest: plan, rules, timestamp: "2026-10-10T09:00:04.100Z", expiresAt: "2026-10-17T00:00:00.000Z" });
      return { denial, override: { version: 1, op: "policy-override", gate: subject, timestamp: at, resolvedBy: "alice", planDigest: denial.planDigest, note } };
    };
    const plan = answer("migrate-dev", D2, ["no-drops", "small-runs"], "2026-10-10T09:00:04.600Z", "nothing reads it");
    const revert = answer("migrate-dev/revert-m1", D1, ["no-drops"], "2026-10-10T09:00:04.700Z", "added by mistake");
    const other = answer("migrate-prod", D2, ["no-drops"], "2026-10-10T09:00:04.800Z", "another Op's");
    const { entries } = deriveAudit({
      environment: "dev",
      history: "yodeler.history",
      rows: rows(),
      ledger: ledger(),
      // As chant's reader (readGateAuditLedgers) gives the override gate's lines.
      overrides: { op: "migrate-dev", path: "_gates/policy-override.jsonl", lines: [plan.denial, revert.denial, other.denial, plan.override, revert.override, other.override].map((record) => ({ record })) },
    });
    expect(entries.filter((e) => e.kind === "override" && "ledger" in e.source && e.source.ledger === "_gates/policy-override.jsonl").map((e) => [e.digest, e.detail, "gate" in e.source ? e.source.gate : ""])).toEqual([
      [D2, "no-drops, small-runs: nothing reads it", "migrate-dev"],
      [D1, "no-drops: added by mistake", "migrate-dev/revert-m1"],
    ]);
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
    const l = devLines();
    const { gaps } = derive(rows(), ledger({ ...l, resolutions: l.resolutions.filter((r) => r.planDigest !== D2 || r.gate !== "approve-migrate-dev") }));
    expect(gaps).toEqual([{ environment: "dev", kind: "approval", detail: `m2 was applied under ${D2} (yodeler.history seq 8), but _gates/migrate-dev.jsonl holds no approval of migrate-dev / approve-migrate-dev for that digest` }]);
  });

  it("needs no approval for a baseline, and checks none without a ledger", () => {
    seq = 0;
    expect(derive([row({ migration_id: "base", status: "succeeded", plan_digest: "", note: "baseline" })]).gaps).toEqual([]);
    expect(derive(rows(), undefined).gaps).toEqual([]);
  });
});

describe("the audit log of a waves project (#87)", () => {
  const WAVE = "jcs1-sha256:wave";
  const waveNote = (status: "approved" | "not-required") => JSON.stringify({ wave: { wave: 2, op: "yodel-apply", gate: "yodel-apply-wave-2", digest: WAVE, status } });
  const waveRows = (status: "approved" | "not-required") => {
    seq = 0;
    return [row({ migration_id: "m1", status: "started", note: waveNote(status) }), row({ migration_id: "m1", status: "succeeded" })];
  };
  const waves = (resolutions: Array<{ gate: string; planDigest: string }>) => ({
    op: "yodel-apply",
    path: "_gates/yodel-apply.jsonl",
    gate: "yodel-apply-wave-2",
    lines: linesOf("yodel-apply", {
      pending: [{ gate: "yodel-apply-wave-2", timestamp: "2026-10-10T08:59:00.000Z", planDigest: WAVE }],
      resolutions: resolutions.map((r) => ({ ...r, timestamp: "2026-10-10T08:59:30.000Z", resolvedBy: "alice" })),
    }),
  });
  const migrationsGateOnly = ledger({ pending: [], resolutions: [] });

  it("finds a wave's approval on the wave's gate, for the set digest its started row records", () => {
    const { entries, gaps } = deriveAudit({ environment: "dev", history: "h", rows: waveRows("approved"), ledger: migrationsGateOnly, waves: waves([{ gate: "yodel-apply-wave-2", planDigest: WAVE }]) });
    expect(gaps).toEqual([]);
    expect(kinds(entries)).toEqual(["approval-requested", "approved", "applied m1"]);
    expect(entries.find((e) => e.kind === "applied")?.wave).toEqual({ gate: "yodel-apply-wave-2", digest: WAVE, status: "approved" });
    expect(entries.find((e) => e.kind === "approved")?.source).toEqual({ ledger: "_gates/yodel-apply.jsonl", op: "yodel-apply", gate: "yodel-apply-wave-2" });
  });

  it("names a wave applied with no approval of its digest on its gate as a gap; the migrations gate alone does not count", () => {
    const other = deriveAudit({ environment: "dev", history: "h", rows: waveRows("approved"), ledger: migrationsGateOnly, waves: waves([{ gate: "yodel-apply-wave-1", planDigest: WAVE }]) });
    expect(other.gaps.map((g) => g.detail)).toEqual([`m1 was applied by a wave under ${WAVE} (h seq 2), but _gates/yodel-apply.jsonl holds no approval of yodel-apply / yodel-apply-wave-2 for that digest`]);
    const onMigrations = deriveAudit({
      environment: "dev",
      history: "h",
      rows: waveRows("approved"),
      ledger: ledger({ pending: [], resolutions: [{ gate: "approve-migrate-dev", timestamp: "2026-10-10T08:59:30.000Z", resolvedBy: "alice", planDigest: D1 }] }),
      waves: waves([]),
    });
    expect(onMigrations.gaps).toHaveLength(1);
  });

  it("needs no approval for a wave whose policy at the base needed none", () => {
    expect(deriveAudit({ environment: "dev", history: "h", rows: waveRows("not-required"), ledger: migrationsGateOnly, waves: waves([]) }).gaps).toEqual([]);
  });

  it("keeps the ids of entries with no wave", () => {
    const plain = derive().entries.map((e) => e.id);
    expect(deriveAudit({ environment: "dev", history: "yodeler.history", rows: rows(), ledger: ledger(), waves: waves([]) }).entries.filter((e) => !("gate" in e.source && e.source.gate === "yodel-apply-wave-2")).map((e) => e.id)).toEqual(plain);
  });
});

describe("audit.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "yodel-audit-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = (entries: AuditEntry[]): AuditLine[] => toAuditLines(entries, "/work/shop");
  const detailText = (l: AuditLine) => (l.detail as { text?: string } | undefined)?.text;

  it("appends only what it does not have, and --check names a line whose ledger line or history row was removed", () => {
    const path = join(dir, "audit.jsonl");
    const full = lines(derive().entries);
    appendAudit(path, compareAudit(readAuditFile(path), full, ["dev"]).added);
    expect(readAuditFile(path).entries).toHaveLength(full.length);
    // Again: nothing new.
    expect(compareAudit(readAuditFile(path), full, ["dev"])).toEqual({ missing: [], added: [] });
    const text = readFileSync(path, "utf8");

    // A pending line removed from the ledger.
    const l = devLines();
    const noPending = lines(derive(rows(), ledger({ ...l, pending: l.pending.slice(1) })).entries);
    expect(compareAudit(readAuditFile(path), noPending, ["dev"]).missing.map((e) => e.kind)).toEqual(["approval-requested"]);
    // A history row removed.
    const noRow = lines(derive(rows().filter((r) => r.seq !== 5)).entries);
    expect(compareAudit(readAuditFile(path), noRow, ["dev"]).missing.map(detailText)).toEqual(["check table-empty failed: 1 row"]);
    // An environment not read is not compared.
    expect(compareAudit(readAuditFile(path), [], ["prod"]).missing).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("reads a file of yodel's earlier entries, or a mix, and appends no entry it already holds in either form", () => {
    const path = join(dir, "audit-mixed.jsonl");
    const entries = derive().entries;
    const [first, second] = entries;
    // The first two entries in yodel's own format, the rest absent.
    writeFileSync(path, [first, second].map((e) => `${JSON.stringify(e)}\n`).join(""));
    const file = readAuditFile(path);
    expect(file.entries.map((e) => e.id)).toEqual([first?.id, second?.id]);
    const { added, missing } = compareAudit(file, lines(entries), ["dev"]);
    expect(missing).toEqual([]);
    expect(added).toHaveLength(entries.length - 2);
    appendAudit(path, added);
    const written = readFileSync(path, "utf8").trim().split("\n").map((t) => JSON.parse(t) as Record<string, unknown>);
    // The earlier lines stay as they were; the new ones are chant's.
    expect(written.slice(0, 2)).toEqual([first, second]);
    expect(written.slice(2).every((w) => w.schema === "chant.audit/v1")).toBe(true);
    expect(compareAudit(readAuditFile(path), lines(entries), ["dev"])).toEqual({ missing: [], added: [] });
  });
});

describe("the audit lines in chant's format (#385)", () => {
  const ajvAudit = new Ajv2020({ allErrors: true, strict: false });
  const validateChant = ajvAudit.compile(chantAuditSchema as object);
  const entries = derive().entries;

  it("gives every entry as a line chant's published audit schema and readAuditLine accept, under chant's kinds", () => {
    const out = toAuditLines(entries, "/work/shop");
    expect(out).toHaveLength(entries.length);
    for (const l of out) {
      expect(validateChant(l), JSON.stringify(validateChant.errors)).toBe(true);
      expect(readAuditLine(JSON.parse(JSON.stringify(l)))).toEqual(l);
      expect(l).toMatchObject({ schema: "chant.audit/v1", product: "sql-yodeler", project: "/work/shop", environment: "dev" });
    }
    expect(out.map((l) => [l.product_kind ?? l.kind, l.kind])).toEqual([
      ["approval-requested", "approval-requested"],
      ["approved", "approved"],
      ["silenced", "recorded"],
      ["applied", "applied"],
      ["approval-requested", "approval-requested"],
      ["approved", "approved"],
      ["override", "override-recorded"],
      ["refused", "refused"],
      ["applied", "applied"],
      ["repaired", "recorded"],
    ]);
    // The same id, so a file of earlier entries and one of lines agree on what they hold.
    expect(out.map((l) => l.id)).toEqual(entries.map((e) => e.id));
  });

  it("loses nothing: chant's toProductAuditLine gives each earlier entry back, fixture by fixture", () => {
    for (const e of entries) {
      expect(toProductAuditLine(toAuditLines([e], "/work/shop")[0] as AuditLine, "sql-yodeler")).toEqual(e);
      expect(toAuditEntry(toAuditLines([e], "/work/shop")[0] as AuditLine)).toEqual(e);
    }
  });

  it("keeps yodel's word for every kind it derives, with chant's word beside it, and gives back each one", () => {
    const at = "2026-10-10T09:00:00.000Z";
    const source = { history: "yodeler.history", seq: 1, run: "r" };
    const base = { id: "sha256:x", at, environment: "dev", by: "ci", migration: "m1", digest: D1, detail: "d", source };
    const want: Record<string, string> = {
      "approval-requested": "approval-requested",
      approved: "approved",
      override: "override-recorded",
      silenced: "recorded",
      applied: "applied",
      refused: "refused",
      failed: "applied",
      repaired: "recorded",
      reverted: "recorded",
      step: "recorded",
      "wave-run": "recorded",
      spent: "recorded",
    };
    expect(Object.keys(want).sort()).toEqual([...AUDIT_KINDS].sort());
    for (const [kind, chantKind] of Object.entries(want)) {
      const e = { ...base, kind, wave: { gate: "g", digest: "d", status: "approved" } } as unknown as AuditEntry;
      const l = toAuditLines([e], "p")[0] as AuditLine;
      expect(l.kind, kind).toBe(chantKind);
      expect(l.product_kind, kind).toBe(kind === chantKind ? undefined : kind);
      expect(validateChant(l), kind).toBe(true);
      expect(toAuditEntry(l), kind).toEqual(e);
    }
  });
});

const chain = [{ id: "m1" }, { id: "m2" }, { id: "m3" }] as unknown as Migration[];
const project = { dir: "/work/shop", dialect: "clickhouse", config: {}, configPath: "/work/shop/chant.config.ts", sourceDir: "src" } as unknown as Project;
const port = (l: Lines): GateLedgerPort => ({
  read: () => Promise.resolve(records("migrate-dev", l)) as ReturnType<GateLedgerPort["read"]>,
  appendPending: () => Promise.reject(new Error("read only")),
});
const sources: ReportSources = {
  rows: (_p, env) => (env === "prod" ? Promise.reject(new Error("connect ECONNREFUSED 10.0.0.9:8123")) : Promise.resolve({ rows: env === "dev" ? rows() : rows().slice(0, 3), history: `yodel_${env}.history` })),
  op: (_p, env) => Promise.resolve({ name: `migrate-${env}`, gate: `approve-migrate-${env}`, filePath: "", quorum: false }),
  ledger: () => Promise.resolve(port(devLines())),
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

  // The text and the entries' ids as yodel 0.7.0 wrote them, before chant read the ledger (#212): an audit.jsonl from then still matches.
  it("says what it said before chant read the ledger, with the same ids", () => {
    expect(derive().entries.map((e) => e.id)).toEqual([
      "sha256:b9f98bbf4f866529a67e670e",
      "sha256:c082956ace6c58c028925df2",
      "sha256:d6abcfa52c5a76ad60df240e",
      "sha256:bcfa90a4407dc175862f5db3",
      "sha256:ecd59d3ade2298fb938ea87d",
      "sha256:d64d099dc63dd0ab79797c40",
      "sha256:42710b2f2363a359bceb2349",
      "sha256:5c3c2dcf5bc5cfa55216debe",
      "sha256:ecaa58143bb4e81be9b16202",
      "sha256:b213a5fd00589e22de80ff31",
    ]);
    const wave = { op: "yodel-apply", path: "_gates/yodel-apply.jsonl", gate: "yodel-apply-wave-2", lines: linesOf("yodel-apply", { pending: [{ gate: "yodel-apply-wave-2", timestamp: "2026-10-10T08:59:00.000Z", planDigest: "jcs1-sha256:wave", runId: "w1" }], resolutions: [{ gate: "yodel-apply-wave-2", planDigest: "jcs1-sha256:wave", timestamp: "2026-10-10T08:59:30.000Z", resolvedBy: "alice", note: "ok" }] }) };
    const waveRows = rows().map((x) => (x.seq === 1 ? { ...x, note: JSON.stringify({ wave: { wave: 2, op: "yodel-apply", gate: "yodel-apply-wave-2", digest: "jcs1-sha256:wave", status: "approved" } }) } : x));
    const fromWaves = deriveAudit({ environment: "dev", history: "yodeler.history", rows: waveRows, ledger: ledger(), waves: wave }).entries.filter((e) => "ledger" in e.source && e.source.op === "yodel-apply");
    expect(fromWaves.map((e) => [e.kind, e.id, e.detail])).toEqual([
      ["approval-requested", "sha256:72228ff46fe57edc2f830df6", "run w1"],
      ["approved", "sha256:9c3c995d6fd3835da71341a6", "ok"],
    ]);
    expect(renderReportText(r)).toBe(
      [
        "Report for /work/shop (clickhouse, 3 environments)",
        "",
        "migration  dev                       staging                   prod",
        "m1         applied 2026-10-10 09:00  applied 2026-10-10 09:00  unread",
        "m2         applied 2026-10-10 09:00  pending                   unread",
        "m3         pending                   pending                   unread",
        "",
        "prod: the history could not be read: connect ECONNREFUSED 10.0.0.9:8123",
        "",
        "Gaps (1):",
        "  staging: m1 was applied under jcs1-sha256:1111 (yodel_staging.history seq 3), but _gates/migrate-staging.jsonl holds no approval of migrate-staging / approve-migrate-staging for that digest",
        "",
        "Audit (13 entries):",
        "  2026-10-10T08:59:00.000Z  dev  approval-requested  jcs1-sha256:1111  (run r1)",
        "  2026-10-10T08:59:30.000Z  dev  approved  by alice  jcs1-sha256:1111",
        "  2026-10-10T09:00:01.000000Z  dev  silenced  m1  by ci@host  jcs1-sha256:1111  (step 0: destructive TICKET-1)",
        "  2026-10-10T09:00:01.000000Z  staging  silenced  m1  by ci@host  jcs1-sha256:1111  (step 0: destructive TICKET-1)",
        "  2026-10-10T09:00:03.000000Z  dev  applied  m1  by ci@host  jcs1-sha256:1111",
        "  2026-10-10T09:00:03.000000Z  staging  applied  m1  by ci@host  jcs1-sha256:1111",
        "  2026-10-10T09:00:03.500Z  dev  approval-requested  jcs1-sha256:2222  (run r2)",
        "  2026-10-10T09:00:04.000Z  dev  approved  by alice  jcs1-sha256:2222",
        "  2026-10-10T09:00:04.500Z  dev  override  by alice  jcs1-sha256:2222  (no-drops: nothing reads it)",
        "  2026-10-10T09:00:04.500Z  staging  override  by alice  jcs1-sha256:2222  (no-drops: nothing reads it)",
        "  2026-10-10T09:00:05.000000Z  dev  refused  m2  by ci@host  jcs1-sha256:2222  (check table-empty failed: 1 row)",
        "  2026-10-10T09:00:08.000000Z  dev  applied  m2  by ci@host  jcs1-sha256:2222",
        "  2026-10-10T09:00:09.000000Z  dev  repaired  m2  by bob@laptop  jcs1-sha256:2222  (whitespace only)",
        "",
      ].join("\n"),
    );
  });

  it("renders as text and as a self-contained page", () => {
    const text = renderReportText(r);
    expect(text).toContain("migration  dev                       staging                   prod");
    expect(text).toContain("m3         pending                   pending                   unread");
    expect(text).toContain("prod: the history could not be read");
    const html = renderReportHtml({ ...r, project: "<script>" });
    expect(html).toMatch(/^<!doctype html>/);
    // The hat is the one image and the icon, inline as data: URIs; nothing else loads.
    expect(html).toContain(`<h1 class="brand">${HAT_IMG}Migrations report</h1>`);
    expect(html.replace(HAT_ICON, "").replace(HAT_IMG, "")).not.toMatch(/<script|src=|href=/);
    expect(html).toContain("&lt;script&gt;");
  });

  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addSchema(readSchema("report"));
  const validate = ajv.getSchema(schemaId("report"));

  it("is what yodel report --json prints in audit[] and auditFile.missing, the other fields as before", () => {
    const doc = reportJson(r, { path: "audit.jsonl", appended: 0, missing: toAuditLines(r.audit.slice(0, 1), r.project) });
    const { audit, auditFile, ...others } = doc;
    const { audit: _earlier, ...before } = r;
    expect(_earlier).toHaveLength(r.audit.length);
    expect(others).toEqual(before);
    expect(audit).toEqual(toAuditLines(r.audit, r.project));
    expect((auditFile as { missing: unknown[] }).missing).toHaveLength(1);
    expect((audit as AuditLine[]).map(toAuditEntry)).toEqual(r.audit);
  });

  it("validates against schemas/report.schema.json, with and without the audit file", () => {
    const earlier = { ...r, audit: r.audit };
    const lines = toAuditLines(r.audit.slice(0, 1), r.project);
    for (const doc of [reportJson(r), reportJson(r, { path: "audit.jsonl", appended: 3, missing: lines }), { ...earlier }, { ...earlier, auditFile: { path: "a", appended: 0, missing: r.audit.slice(0, 1) } }]) {
      expect(validate?.(JSON.parse(JSON.stringify(doc))), JSON.stringify(validate?.errors)).toBe(true);
    }
  });

  it("has every field docs/audit.md describes, and the docs describe every field", () => {
    const schema = readSchema("report") as { properties: Record<string, unknown>; $defs: Record<string, unknown> };
    const deref = (s: unknown): Record<string, unknown> => {
      const o = s as Record<string, unknown>;
      if (typeof o.$ref === "string") return deref(schema.$defs[o.$ref.replace("#/$defs/", "")]);
      // An audit entry is chant's line or yodel's earlier entry; the docs describe the line.
      if (Array.isArray(o.oneOf) && o.oneOf.length === 2 && JSON.stringify(o.oneOf[0]).includes("/line")) return deref(o.oneOf[0]);
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
