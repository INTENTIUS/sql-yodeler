/**
 * The report as text, and as a self-contained HTML page (the run view): one
 * row per migration (each merge that added one), one column per
 * environment, in the order they were asked for, so a change's progress from
 * dev to prod reads left to right. Then the gaps and the audit log.
 */

import { HAT_CSS, HAT_ICON, HAT_IMG } from "../brand.js";
import type { AuditEntry } from "./audit.js";
import type { EnvironmentMigration, Report } from "./model.js";

const short = (d: string | undefined): string => (d ? (d.length > 24 ? `${d.slice(0, 24)}...` : d) : "");
const day = (t: string | undefined): string => (t ? t.slice(0, 16).replace("T", " ") : "");

function cell(m: EnvironmentMigration | undefined): string {
  if (!m) return "-";
  if (m.state === "applied") return `applied ${day(m.at)}`;
  return m.state;
}

export function renderReportText(r: Report, extra: { check?: { file: string; missing: readonly string[]; appended: number } } = {}): string {
  const lines = [`Report for ${r.project} (${r.dialect}, ${String(r.environments.length)} environment${r.environments.length === 1 ? "" : "s"})`, ""];
  const head = ["migration", ...r.environments.map((e) => e.name)];
  const rows = r.migrations.map((id) => [id, ...r.environments.map((e) => (e.error ? "unread" : cell(e.migrations.find((m) => m.id === id))))]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  lines.push(fmt(head), ...rows.map(fmt));
  if (r.migrations.length === 0) lines.push("(no migrations)");

  for (const e of r.environments) {
    if (e.error) lines.push("", `${e.name}: ${e.error}`);
    for (const n of e.notes) lines.push("", `${e.name}: ${n}`);
  }

  lines.push("", r.gaps.length === 0 ? "Gaps: none. Every applied migration has its approval on the ledger, and no history row is missing." : `Gaps (${String(r.gaps.length)}):`);
  for (const g of r.gaps) lines.push(`  ${g.environment}: ${g.detail}`);

  if (extra.check) {
    const c = extra.check;
    if (c.missing.length === 0) lines.push("", `${c.file}: every entry is still in the sources${c.appended > 0 ? `; ${String(c.appended)} new entr${c.appended === 1 ? "y" : "ies"} appended` : ""}.`);
    else lines.push("", `${c.file}: ${String(c.missing.length)} entr${c.missing.length === 1 ? "y is" : "ies are"} no longer in the history or the ledger:`, ...c.missing.map((m) => `  ${m}`));
  }

  lines.push("", `Audit (${String(r.audit.length)} entries):`);
  for (const a of r.audit) lines.push(`  ${auditLine(a)}`);
  return `${lines.join("\n")}\n`;
}

export function auditLine(a: AuditEntry): string {
  return [a.at, a.environment, a.kind, a.migration ?? "", a.by ? `by ${a.by}` : "", a.digest ? short(a.digest) : "", a.detail ? `(${a.detail})` : ""].filter(Boolean).join("  ");
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The run view: a page with no external resources, safe to upload as a CI artifact and open from disk. */
export function renderReportHtml(r: Report): string {
  const th = r.environments.map((e) => `<th scope="col">${esc(e.name)}${e.op ? `<br><small>${esc(e.op.name)}</small>` : ""}</th>`).join("");
  const body = r.migrations
    .map((id) => {
      const tds = r.environments
        .map((e) => {
          if (e.error) return `<td class="unread">unread</td>`;
          const m = e.migrations.find((x) => x.id === id);
          if (!m) return `<td class="none">-</td>`;
          const lines: string[] = [m.state];
          if (m.at) lines.push(day(m.at));
          if (m.by) lines.push(`by ${m.by}`);
          if (m.approvedBy) lines.push(`approved by ${m.approvedBy}`);
          const title = m.digest ? ` title="${esc(m.digest)}"` : "";
          return `<td class="${m.state}"${title}>${lines.map((l, i) => (i === 0 ? `<b>${esc(l)}</b>` : `<small>${esc(l)}</small>`)).join("<br>")}</td>`;
        })
        .join("");
      return `<tr><th scope="row"><code>${esc(id)}</code></th>${tds}</tr>`;
    })
    .join("\n");
  const notes = r.environments.flatMap((e) => [...(e.error ? [`${e.name}: ${e.error}`] : []), ...e.notes.map((n) => `${e.name}: ${n}`)]);
  const gaps = r.gaps.length === 0 ? `<p class="ok">No gaps: every applied migration has its approval on the ledger, and no history row is missing.</p>` : `<ul class="gaps">${r.gaps.map((g) => `<li><b>${esc(g.environment)}</b> ${esc(g.detail)}</li>`).join("")}</ul>`;
  const audit = r.audit
    .map((a) => `<tr class="k-${a.kind}"><td>${esc(day(a.at))}</td><td>${esc(a.environment)}</td><td>${esc(a.kind)}</td><td><code>${esc(a.migration ?? "")}</code></td><td>${esc(a.by ?? "")}</td><td title="${esc(a.digest ?? "")}"><code>${esc(short(a.digest))}</code></td><td>${esc(a.detail ?? "")}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Migrations report</title>
${HAT_ICON}
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --applied: #e3f4e8; --pending: #fff6db; --failed: #fde4e1; --started: #fde4e1; }
@media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #ececf0; --muted: #a1a1a6; --line: #3a3a3c; --applied: #1f3a29; --pending: #3d3317; --failed: #4a2420; --started: #4a2420; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 24px 16px; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; }
.meta, small { color: var(--muted); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }
td.applied { background: var(--applied); } td.pending { background: var(--pending); } td.failed, td.started { background: var(--failed); }
code { font: 12px ui-monospace, monospace; }
.gaps li { color: #c0392b; } .ok { color: var(--muted); }
${HAT_CSS}
</style>
</head>
<body>
<main>
<h1 class="brand">${HAT_IMG}Migrations report</h1>
<p class="meta">${esc(r.project)} (${esc(r.dialect)}), generated ${esc(r.generatedAt)}. One row per migration, one column per environment.</p>
${notes.length > 0 ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
<div class="scroll"><table>
<thead><tr><th scope="col">migration</th>${th}</tr></thead>
<tbody>
${body}
</tbody>
</table></div>
<h2>Gaps</h2>
${gaps}
<h2>Audit log (${String(r.audit.length)} entries)</h2>
<div class="scroll"><table>
<thead><tr><th>when</th><th>environment</th><th>what</th><th>migration</th><th>by</th><th>digest</th><th>detail</th></tr></thead>
<tbody>
${audit}
</tbody>
</table></div>
</main>
</body>
</html>
`;
}
