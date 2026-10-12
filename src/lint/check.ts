/**
 * `yodel lint` over a migrations directory: every rule in `./rules.ts`,
 * offline, with no server. Optionally against one environment's history
 * (`--env`), which turns the checksum rule from "the files changed since
 * yodel wrote them" into "an applied migration changed since it ran".
 *
 * Rules that need more than the directory, such as the replay check (#11),
 * plug in as {@link ProjectRule}s through {@link LintOptions.rules}.
 */

import { diffStatements, type MigrationStep } from "@intentius/chant-lexicon-sql/migration-statements";
import type { BuildOutput } from "../chant/build.js";
import type { Project } from "../project.js";
import { checkpointProblems, computeChecksum, emptyBuild, HAND_TEMPLATE_MARK, isHandWritten, scanMigrations, type Migration, type MigrationProblem, type MigrationScan } from "../migrations/index.js";
import type { VersionedStatus } from "../versioned/state.js";
import { levelOf, type LintSettings } from "./config.js";
import { LINT_RULES, type LintLevel, type LintRule } from "./rules.js";
import { mapMigrationSql, type Silence } from "./silences.js";
import { createdObjects, refusedStep, stepFindings, unreadableStep, type Dialect, type StepFinding } from "./statements.js";
import { routineFindings } from "./routines.js";
import { accessFindings } from "./access.js";
import { namingFindings } from "./naming.js";
import { SCHEMA_RULES, schemaFindings } from "./schema-checks.js";
import { policyRules } from "./policies.js";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";

/** One thing a rule found. */
export interface Finding {
  rule: string;
  level: LintLevel;
  message: string;
  /** The migration it is in, when it is in one. */
  migration?: string;
  /** The step, an index into the migration's `steps`. */
  step?: number;
  /** The step's object on the server (`database.table`, `schema.table`). */
  object?: string;
  /** A line in migration.sql, or in {@link file}. */
  line?: number;
  /** A file of another tool's migrations directory the finding is on (yodel check, #1), relative to the report's `dir`. */
  file?: string;
  /** Set when a `-- yodel:allow` line silenced it: the reason given. A silenced finding fails nothing. */
  silenced?: string;
}

/** What a rule reports, before its level and any silence are applied. */
export type RawFinding = Omit<Finding, "level" | "silenced"> & {
  /** Overrides the rule's level for this one finding (a pending migration edited, with --env, is a warning). */
  level?: LintLevel;
};

export interface LintContext {
  /** The migrations directory, absolute. */
  dir: string;
  scan: MigrationScan;
  dialect: Dialect | undefined;
  project: Project | undefined;
}

/**
 * A rule that checks the project as a whole and may reach a server or the
 * emulator: the hook for the replay check (#11). Its findings get levels
 * from `yodel.config.ts` like any rule's; `yodel lint --rules` lists it.
 */
export interface ProjectRule {
  rule: LintRule;
  check: (ctx: LintContext) => Promise<RawFinding[]>;
}

export interface LintOptions {
  /** The project's dialect. Every migration must be this dialect. */
  dialect?: Dialect;
  project?: Project;
  settings?: LintSettings;
  /** An environment's history compared with the directory (`compareHistory`), for --env. */
  history?: { environment: string; status: VersionedStatus };
  /** More rules: the replay check (#11) plugs in here. */
  rules?: readonly ProjectRule[];
  /** The project's own checks, `chant.config.ts` `lint.policies` (#227), run with the schema checks. */
  policies?: readonly PostSynthCheck[];
}

export interface LintReport {
  dir: string;
  dialect: Dialect | undefined;
  environment: string | undefined;
  /** Every migration read, sorted by id. */
  migrations: string[];
  findings: Finding[];
  /** The silences each migration's migration.sql holds, by migration id. */
  silences: Record<string, Silence[]>;
  errors: number;
  warnings: number;
  silenced: number;
  /** A project with no migrations (#249): the findings are over the declared schema, and with an environment over the plan against it. */
  declarative?: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";

const UPDATE = "if it is not applied in any environment, record its new checksum with yodel lint --update-checksum <id>; if it is, undo the edit, or record it with yodel repair <id> --reason ... <env>";

/** The `-- yodel:allow` lines silences.ts reads. */
const ALLOW_LINE = /^\s*--\s*yodel:allow\b.*(?:\r?\n|$)/gm;

/**
 * Whether the only change to `m` since its checksum was recorded is added
 * `-- yodel:allow` lines: its files without them hash to the recorded
 * checksum. Then nothing it runs changed, and the fix is to record the
 * checksum (#19).
 */
export function onlySilencesAdded(m: Migration | undefined, recorded: string): boolean {
  if (!m || !recorded) return false;
  const sql = m.files.sql.replace(ALLOW_LINE, "");
  return sql !== m.files.sql && computeChecksum({ ...m.files, sql }) === recorded;
}

function directoryFindings(problems: readonly MigrationProblem[], history: LintOptions["history"], migrations: readonly Migration[] = []): RawFinding[] {
  const out: RawFinding[] = [];
  for (const p of problems) {
    switch (p.kind) {
      case "fork":
        // The rule already says "fork"; the directory problem's own "fork: " prefix would say it twice.
        // Placed on the newest child, the migration a rebase moves: the one a forge annotates (#129).
        out.push({ rule: "fork", message: p.message.replace(/^fork: /, ""), ...(p.children.length > 0 ? { migration: p.children[p.children.length - 1] } : {}) });
        break;
      case "checksum": {
        if (history) {
          const applied = history.status.applied.find((a) => a.id === p.id && a.index !== undefined);
          // Applied: the history decides (below). Pending: an edit before it runs is allowed; say so.
          if (!applied) {
            out.push({
              rule: "checksum",
              level: "warning",
              migration: p.id,
              message: `${p.message}. It is not applied in ${history.environment}, so the edit is allowed there; record the new checksum with yodel lint --update-checksum ${p.id}`,
            });
          }
          break;
        }
        if (onlySilencesAdded(migrations.find((m) => m.id === p.id), p.check.recorded)) {
          out.push({ rule: "checksum", migration: p.id, message: `${p.id}: the only change since its checksum was recorded is its added -- yodel:allow lines, and nothing it runs changed; record them with yodel lint --update-checksum ${p.id} (and, where it is already applied, yodel repair <env> ${p.id} --reason ...)` });
          break;
        }
        out.push({ rule: "checksum", migration: p.id, message: `${p.message}; ${UPDATE.replaceAll("<id>", p.id)}` });
        break;
      }
      case "missing-parent":
      case "id-mismatch":
        out.push({ rule: "directory", migration: p.id, message: p.message });
        break;
      case "unreachable":
        out.push({ rule: "directory", message: p.message });
        break;
      case "unreadable":
        out.push({ rule: "directory", message: p.message });
        break;
    }
  }
  if (history) {
    for (const mm of history.status.mismatches) {
      out.push({ rule: "checksum", migration: mm.id, ...(mm.kind === "part-way" ? { step: mm.statement } : {}), message: `${history.environment}: ${mm.message}` });
    }
  }
  return out;
}

/** The objects of a build that the lexicon cannot read, each alone; `[]` when it reads them all. */
function unreadableObjects(schema: BuildOutput, options: { defaultDatabase?: string; defaultSchema?: string }): Array<{ export: string; type: string; ddl: string; error: string }> {
  const empty = emptyBuild(schema);
  const out: Array<{ export: string; type: string; ddl: string; error: string }> = [];
  for (const o of schema.objects) {
    try {
      diffStatements(empty, { ...schema, objects: [{ ...o, dependsOn: [] }] }, options);
    } catch (e) {
      out.push({ export: o.export, type: o.type ?? "", ddl: o.ddl, error: message(e) });
    }
  }
  return out;
}

/**
 * The lexicon reads every migration's recorded schema: the diff from its
 * parent's schema to its own is made again, as `yodel new` made it. An
 * object it cannot read is reported once, in the first migration that
 * records it; a failure no single object explains is reported whole.
 */
function recordedSchemaFindings(migrations: readonly Migration[], dialect: Dialect | undefined): RawFinding[] {
  const out: RawFinding[] = [];
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const reported = new Set<string>();
  for (const m of migrations) {
    const doc = m.document;
    const schema = doc.schema;
    const recorded = doc.dialect as unknown;
    if (recorded !== "clickhouse" && recorded !== "postgres") {
      out.push({ rule: "directory", migration: m.id, message: `${m.id}/migration.json: dialect ${JSON.stringify(recorded)} is neither clickhouse nor postgres` });
      continue;
    }
    if (dialect !== undefined && recorded !== dialect) {
      out.push({ rule: "directory", migration: m.id, message: `${m.id} is a ${recorded} migration, but the project's dialect is ${dialect}` });
      continue;
    }
    if (!Array.isArray(schema.objects) || schema.dialect !== recorded) {
      out.push({ rule: "unreadable-object", migration: m.id, message: `${m.id}: its recorded schema is not a ${recorded} build output (a dialect and a list of objects)` });
      continue;
    }
    const parent = m.parent === null ? undefined : byId.get(m.parent)?.document.schema;
    const before = parent && Array.isArray(parent.objects) && parent.dialect === schema.dialect ? parent : emptyBuild(schema);
    const options = {
      ...(doc.defaultDatabase !== undefined ? { defaultDatabase: doc.defaultDatabase } : {}),
      ...(doc.defaultSchema !== undefined ? { defaultSchema: doc.defaultSchema } : {}),
    };
    try {
      diffStatements(before, schema, options);
      continue;
    } catch (e) {
      const bad = unreadableObjects(schema, options);
      for (const o of bad) {
        const key = `${o.export}\u0000${o.type}\u0000${o.ddl}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push({ rule: "unreadable-object", migration: m.id, object: o.export, message: `${o.export} (${o.type || "no type"}) in ${m.id}'s recorded schema: the sql lexicon cannot read it: ${o.error}` });
      }
      if (bad.length === 0) out.push({ rule: "unreadable-object", migration: m.id, message: `${m.id}: the sql lexicon cannot read its recorded schema against its parent's: ${message(e)}` });
    }
  }
  return out;
}

/** Each checkpoint's recorded schema against the one it was written from (#63): rule `checkpoint`. */
function checkpointFindings(migrations: readonly Migration[]): RawFinding[] {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  return migrations.flatMap((m) => checkpointProblems(m, byId).map((message) => ({ rule: "checkpoint", migration: m.id, message })));
}

const stepName = (s: MigrationStep): string | undefined => (typeof (s as { name?: unknown }).name === "string" ? s.name : undefined);

/** Lints the migrations in `dir`. Never throws on what it finds; a finding is a result. */
export async function lintMigrations(dir: string, options: LintOptions = {}): Promise<LintReport> {
  const scan = scanMigrations(dir);
  const extra = options.rules ?? [];
  const rules: Record<string, LintRule> = { ...LINT_RULES, ...SCHEMA_RULES, ...policyRules(options.policies ?? []), ...Object.fromEntries(extra.map((r) => [r.rule.id, r.rule])) };
  const dialect = options.dialect;
  const raw: RawFinding[] = [...directoryFindings(scan.problems, options.history, scan.migrations), ...recordedSchemaFindings(scan.migrations, dialect), ...checkpointFindings(scan.migrations)];

  // Over the recorded schemas (#51): the lexicon's schema checks and the naming rules, each at a step a silence can name.
  const chantRules = (options.project?.config as { lint?: { rules?: Record<string, unknown> } } | undefined)?.lint?.rules;
  const configured = new Set(Object.keys(options.settings?.levels ?? {}));
  const bySchema = new Map<string, RawFinding[]>();
  for (const f of [...schemaFindings(scan.migrations, { dialect, configured, chantRules, ...(options.policies ? { policies: options.policies } : {}), env: options.history?.environment }), ...namingFindings(scan.migrations, options.settings?.naming ?? {})]) {
    bySchema.set(f.migration, [...(bySchema.get(f.migration) ?? []), f]);
  }

  const silenceable = new Set(Object.values(rules).filter((r) => r.silenceable).map((r) => r.id));
  const silences: Record<string, Silence[]> = {};
  const used = new Set<Silence>();
  const statementRaw: Array<RawFinding & { silence?: Silence }> = [];

  const byId = new Map(scan.migrations.map((m) => [m.id, m]));
  for (const m of scan.migrations) {
    const d = m.document.dialect as unknown;
    if (d !== "clickhouse" && d !== "postgres") continue; // reported above
    const steps = m.document.steps;
    const map = mapMigrationSql(m.files.sql, steps, silenceable);
    silences[m.id] = map.silences;
    for (const p of map.problems) raw.push({ rule: p.rule, migration: m.id, message: p.message, ...(p.step !== undefined ? { step: p.step } : {}), ...(p.line !== undefined ? { line: p.line } : {}) });

    if (isHandWritten(m.document)) {
      // A hand-written migration (#248): its steps are the person's statements, so the
      // statement rules run on the schema change it records, its parent's recorded schema
      // against its own, and a silence anywhere in its migration.sql covers its rule there.
      if (steps.length === 0) {
        raw.push({ rule: "migration-sql", migration: m.id, message: `${m.id}: a hand-written migration with no statements recorded; write them in migration.sql${m.files.sql.includes(HAND_TEMPLATE_MARK) ? "" : " (each ending with ;)"} and run yodel lint --update-checksum ${m.id}` });
        continue;
      }
      const silenceFor = (rule: string, step?: number): Silence | undefined => map.silences.find((x) => x.rule === rule && (step === undefined || x.step === step)) ?? map.silences.find((x) => x.rule === rule);
      const push = (f: RawFinding) => {
        const silence = silenceFor(f.rule, f.step);
        if (silence) used.add(silence);
        statementRaw.push({ ...f, ...(silence ? { silence } : {}) });
      };
      steps.forEach((step, i) => {
        if (step.kind === "statement" && step.destructive) push({ rule: "destructive", migration: m.id, step: i, object: step.name, message: `step ${String(i)}: ${step.name}: removes rows that cannot be recovered` });
      });
      const parent = m.document.parent === null ? undefined : byId.get(m.document.parent)?.document.schema;
      const schema = m.document.schema;
      const before = parent && Array.isArray(parent.objects) && parent.dialect === schema.dialect ? parent : emptyBuild(schema);
      let classified: MigrationStep[] = [];
      try {
        classified = diffStatements(before, schema, {
          ...(m.document.defaultDatabase !== undefined ? { defaultDatabase: m.document.defaultDatabase } : {}),
          ...(m.document.defaultSchema !== undefined ? { defaultSchema: m.document.defaultSchema } : {}),
        }).steps;
      } catch {
        // An unreadable recorded schema is reported above (recordedSchemaFindings).
      }
      const createdHere = d === "postgres" ? createdObjects(classified) : undefined;
      for (const cs of classified) {
        const found: StepFinding[] = stepFindings(d, cs, createdHere ? { created: createdHere } : {});
        for (const f of found) {
          const rule: LintRule | undefined = rules[f.rule];
          if (rule?.dialect !== undefined && rule.dialect !== d) continue;
          push({ rule: f.rule, migration: m.id, object: cs.name, message: `${cs.name}: ${f.message}` });
        }
      }
      if (d === "postgres") {
        const doc = { ...m.document, steps: classified };
        for (const f of [...routineFindings(doc), ...accessFindings(doc)]) push({ rule: f.rule, migration: m.id, message: f.message });
      }
      for (const f of bySchema.get(m.id) ?? []) push(f);
      for (const x of map.silences) {
        if (used.has(x)) continue;
        raw.push({ rule: "silence", level: "warning", migration: m.id, step: x.step, line: x.line, message: `migration.sql line ${String(x.line)}: yodel:allow ${x.rule} silences nothing: this migration breaks no ${x.rule} rule` });
      }
      continue;
    }

    const created = d === "postgres" ? createdObjects(steps) : undefined;
    steps.forEach((step, i) => {
      const name = stepName(step);
      const where = { migration: m.id, step: i, ...(name !== undefined ? { object: name } : {}) };
      const unreadable = unreadableStep(d, step);
      if (unreadable) {
        raw.push({ rule: "unreadable-object", ...where, message: `step ${String(i)}: ${unreadable}` });
        return;
      }
      const refused = refusedStep(step);
      if (refused) raw.push({ rule: "refused-step", ...where, message: `step ${String(i)}: yodel apply refuses ${refused}` });
      for (const f of stepFindings(d, step, created ? { created } : {})) {
        const rule = rules[f.rule];
        if (rule?.dialect !== undefined && rule.dialect !== d) continue;
        const silence = map.silences.find((s) => s.step === i && s.rule === f.rule);
        if (silence) used.add(silence);
        statementRaw.push({ rule: f.rule, ...where, message: `step ${String(i)}: ${f.message}`, ...(silence ? { silence } : {}) });
      }
    });
    if (d === "postgres") {
      for (const f of [...routineFindings(m.document), ...accessFindings(m.document)]) {
        const name = stepName(steps[f.step] as MigrationStep);
        const silence = map.silences.find((s) => s.step === f.step && s.rule === f.rule);
        if (silence) used.add(silence);
        statementRaw.push({ rule: f.rule, migration: m.id, step: f.step, ...(name !== undefined ? { object: name } : {}), message: f.message, ...(silence ? { silence } : {}) });
      }
    }
    for (const f of bySchema.get(m.id) ?? []) {
      const silence = f.step === undefined ? undefined : map.silences.find((s) => s.step === f.step && s.rule === f.rule);
      if (silence) used.add(silence);
      statementRaw.push({ ...f, ...(silence ? { silence } : {}) });
    }
    for (const s of map.silences) {
      if (used.has(s)) continue;
      raw.push({ rule: "silence", level: "warning", migration: m.id, step: s.step, line: s.line, message: `migration.sql line ${String(s.line)}: yodel:allow ${s.rule} silences nothing: step ${String(s.step)} breaks no ${s.rule} rule` });
    }
  }

  for (const r of extra) {
    try {
      raw.push(...(await r.check({ dir: scan.dir, scan, dialect, project: options.project })));
    } catch (e) {
      raw.push({ rule: r.rule.id, message: `${r.rule.id} could not run: ${message(e)}` });
    }
  }

  const findings: Finding[] = [];
  for (const f of [...raw, ...statementRaw]) {
    const rule = rules[f.rule];
    const setting = rule ? levelOf(rule, options.settings) : "error";
    if (setting === "off") continue;
    const { silence, level, ...rest } = f as RawFinding & { silence?: Silence };
    findings.push({ ...rest, level: level ?? setting, ...(silence ? { silenced: silence.reason } : {}) });
  }
  findings.sort(
    (a, b) =>
      (a.migration ?? "").localeCompare(b.migration ?? "") ||
      (a.step ?? -1) - (b.step ?? -1) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.rule.localeCompare(b.rule),
  );
  const live = findings.filter((f) => f.silenced === undefined);
  return {
    dir: scan.dir,
    dialect,
    environment: options.history?.environment,
    migrations: scan.migrations.map((m) => m.id),
    findings,
    silences,
    errors: live.filter((f) => f.level === "error").length,
    warnings: live.filter((f) => f.level === "warning").length,
    silenced: findings.length - live.length,
  };
}
