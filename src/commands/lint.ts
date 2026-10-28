import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { isHandWritten, MIGRATION_JSON, recordHandWritten, scanMigrations, serializeDocument } from "../migrations/index.js";
import { buildSchema } from "../chant/build.js";
import { hasMigrations, inspect, migrationsDir, openVersioned } from "../versioned/index.js";
import { declarativeRefusal } from "../config/settings.js";
import { declaredChanges, planEnvironment } from "../chant/plan.js";
import { changeFindings, declarativeLint, declaredSchemaFindings } from "../declarative/review.js";
import type { LintReport, LintSettings } from "../lint/index.js";
import { chantLevel, CODE_QUALITY_FILE, codeQuality, FORGE_FORMAT, forgeFormat, LINT_FORMATS, workflowCommands, type LintFormat, LINT_RULES, SCHEMA_RULES, lintExitCode, lintJson, lintMigrations, lintSettings, renderLint, updateChecksum, type LintOptions, type LintRule } from "../lint/index.js";
import { projectRules, REPLAY_RULE, replayRule } from "../lint/project-rules.js";
import { loadPolicies, policyRules } from "../lint/policies.js";
import type { PostSynthCheck } from "@intentius/chant/lint/post-synth";
import { renderReplay, replayHistory, replayJson, type ReplayResult } from "../replay/index.js";

const usage = "usage: yodel lint [--env <env>] [--replay <env> [--reset] [--reset-shared <profile>]... [--keep]] [--json | --format <format> [--output <file>]] [--dir <project>] [--update-checksum <id>]... [--rules]";

const help = `${usage}

Checks the migrations directory against every lint rule, offline: no server
and no dev database. Every rule is free and runs in CI on every pull request.

A project with no migrations/ directory (the declarative path) has no
migrations to check: yodel lint runs the lexicon's schema checks, the
project's own checks and lint.naming over the build of src/, offline. With
--env <env> it also plans src/ against <env>'s live database and checks the
planned changes against the statement rules that read a change's rule and
class (destructive, pg-rewrite, pg-access, ch-mutation, ch-rebuild,
ch-access, and refused-step for a change that needs its own Op). The plan
carries no statement, so pg-lock, data-dependent and pg-signature are for
versioned migrations, and with no migration.sql nothing is silenced:
lint.rules sets a rule's level. yodel plan <env> shows the same findings.

Rules (yodel lint --rules lists them with their levels):
  fork               two migrations follow the same parent (yodel rebase)
  directory          not one readable chain: a bad name or file, a missing
                     parent, a cycle, a migration of another dialect
  checksum           a migration's files no longer hash to its checksum
  unreadable-object  an object in a recorded schema, or a step, the sql
                     lexicon cannot read or classify; an error, never skipped
  checkpoint         a checkpoint whose recorded schema is no longer its
                     parent's, or that holds a step other than a statement
  destructive        a drop that removes data for good
  pg-rewrite         Postgres: a rewrite or full scan under ACCESS EXCLUSIVE
  pg-lock            Postgres: writes blocked for a whole index build or scan
  pg-signature       Postgres: a function or procedure dropped and created
                     with another signature or result
  data-dependent     Postgres: a statement that can fail on the rows already
                     there (a unique index over duplicates, SET NOT NULL
                     over NULLs), shown with the pre-check yodel apply runs
                     before the migration's first statement; a warning
  naming             a table, column, index or constraint the migration adds
                     breaks yodel.config.ts lint.naming
  SQLPG1xx, SQLCH1xx the sql lexicon's schema checks (chant lint's), on each
                     migration's recorded schema: what it adds to its
                     parent's
  ch-mutation        ClickHouse: a mutation rewriting parts, no rollback
  ch-rebuild         ClickHouse: a rebuild (ClickHouseRebuildOp)
  ch-access          ClickHouse: a privilege or role revoked
  refused-step       a step yodel apply refuses (a manual step, an Op it
                     does not run)
  pg-routine-in-use  Postgres: a function dropped while a declared trigger
                     still executes it
  migration-sql      migration.sql does not hold a statement migration.json
                     records (apply runs migration.json's)
  silence            a yodel:allow line that is wrong or silences nothing
  replay             with --replay <env>: the history, replayed into a fresh
                     database on <env>'s server, does not give a migration's
                     recorded schema (names the first that differs); each
                     checkpoint is replayed on its own, into an empty
                     database

Silencing: a line above a statement in its migration.sql,
  -- yodel:allow <rule> <reason>
silences that statement rule (destructive, pg-rewrite, pg-lock,
pg-signature, pg-access, data-dependent, naming, ch-mutation, ch-rebuild,
ch-access, or a schema check's id) for that one statement. The reason is required,
and yodel apply records the rule, the statement and the reason in every
history row the migration writes (the silences column). Adding the line
changes the migration's checksum: for a migration not yet applied anywhere,
record the new one with --update-checksum <id>.

Levels: yodel.config.ts lint.rules sets a rule to "error", "warning" or
"off", e.g. lint: { rules: { "ch-mutation": "warning" } }. fork, directory,
checksum, unreadable-object and checkpoint are always errors. A schema
check not set there takes chant.config.ts lint.rules' level, else the
check's own.

Naming: yodel.config.ts lint.naming gives a rule per kind (table, column,
index, constraint): a preset (snake_case, camelCase, PascalCase) or a
regular expression the whole name must match, e.g.
lint: { naming: { table: "snake_case", index: "[a-z_]+_idx" } }.

Options:
  --env <env>             also compare with <env>'s history: a
                          checksum error is then an applied migration whose
                          files changed since it ran; a pending migration's
                          edit is a warning. Declarative: also lint the
                          plan against <env>
  --update-checksum <id>  first write <id>'s migration.json checksum to match
                          its files (repeatable); refused with --env when <id>
                          is applied there
  --replay <env>          also replay every migration in order into <env>'s
                          server (a throwaway emulator: chant emulator up
                          --lexicon sql) and compare each with its recorded
                          schema; the databases or schemas the history names
                          must not exist there yet
  --reset                 with --replay: drop those databases or schemas
                          first when they exist. Destructive: never against a
                          server whose data matters
  --reset-shared <profile>
                          with --replay: replay even though <profile> binds
                          the same server and names one of those databases or
                          schemas, which the replay then empties (repeatable).
                          Refused without it, --reset or not
  --keep                  with --replay: leave the replayed database in place
  --rules                 list the rules and their levels, and exit
  --json                  print the findings as JSON (--format json)
  --format <format>       text (the default), json, or the findings as a
                          forge shows them on the migration files (#129):
                          github   the text, then a workflow command per
                                   finding (::error file=...,line=...::),
                                   read by GitHub and Forgejo Actions
                          gitlab   the text, and GitLab's code quality
                                   report written to --output, for the
                                   job's artifacts:reports:codequality
                          forge    github or gitlab, by the forge the job runs
                                   on (GITLAB_CI, GITHUB_ACTIONS), else text:
                                   the check hook yodel ci writes (#294)
                          yodel ci renders each forge's lint job with its own
  --output <file>         with --format gitlab (or forge on GitLab): where the report goes
                          (default ${CODE_QUALITY_FILE}, from the working
                          directory); it is written
                          whatever the findings, so the artifact is always there
  -C, --dir <dir>         the project directory (default: the working directory)

Exit codes:
  0  no errors (warnings and silenced findings do not fail)
  1  at least one error (a replay that differs counts); --replay: the target
     already holds what the history names, and --reset was not given, or
     another profile binds the same server and names one of them and
     --reset-shared does not name it (nothing was run); or lint could not
     run: a bad config, an unknown migration for --update-checksum, a server
     that does not answer (--env)
`;

interface LintArgs {
  env: string | undefined;
  replay: string | undefined;
  reset: boolean;
  resetShared: string[];
  keep: boolean;
  json: boolean;
  format: LintFormat;
  output: string;
  dir: string;
  update: string[];
  rules: boolean;
}

function parseLintArgs(args: string[]): LintArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        env: { type: "string" },
        replay: { type: "string" },
        reset: { type: "boolean" },
        "reset-shared": { type: "string", multiple: true },
        keep: { type: "boolean" },
        json: { type: "boolean" },
        format: { type: "string" },
        output: { type: "string" },
        dir: { type: "string", short: "C" },
        "update-checksum": { type: "string", multiple: true },
        rules: { type: "boolean" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const v = parsed.values;
  const update = v["update-checksum"];
  const replay = typeof v.replay === "string" ? v.replay : undefined;
  const resetShared = Array.isArray(v["reset-shared"]) ? v["reset-shared"].filter((r): r is string => typeof r === "string") : [];
  const asked = typeof v.format === "string" ? v.format : v.json === true ? "json" : "text";
  // --format forge (#294): the job's own forge, so one check hook serves every forge.
  const format = asked === FORGE_FORMAT ? forgeFormat() : asked;
  if (!(LINT_FORMATS as readonly string[]).includes(format)) throw new YodelError(`--format ${format}: it is ${LINT_FORMATS.join(", ")}\n${usage}`);
  if (v.json === true && format !== "json") throw new YodelError(`--json is --format json; give one of them\n${usage}`);
  if (typeof v.output === "string" && format !== "gitlab" && asked !== FORGE_FORMAT) throw new YodelError(`--output goes with --format gitlab\n${usage}`);
  if (replay === undefined && (v.reset === true || v.keep === true || resetShared.length > 0)) throw new YodelError(`--reset, --reset-shared and --keep go with --replay <env>\n${usage}`);
  return {
    env: typeof v.env === "string" ? v.env : undefined,
    replay,
    reset: v.reset === true,
    resetShared,
    keep: v.keep === true,
    json: format === "json",
    format: format as LintFormat,
    output: typeof v.output === "string" ? v.output : CODE_QUALITY_FILE,
    dir: typeof v.dir === "string" ? v.dir : process.cwd(),
    update: Array.isArray(update) ? update.filter((u): u is string => typeof u === "string") : [],
    rules: v.rules === true,
  };
}

/** Every rule `lint.rules` can name: yodel's, the replay check, the lexicon's schema checks and the project's own checks (#227). */
function allRules(policies: readonly PostSynthCheck[] = []): Record<string, LintRule> {
  return { ...LINT_RULES, ...Object.fromEntries(projectRules.map((r) => [r.rule.id, r.rule])), [REPLAY_RULE.id]: REPLAY_RULE, ...SCHEMA_RULES, ...policyRules(policies) };
}

function listRules(io: Io, json: boolean, project: Project, policies: readonly PostSynthCheck[]): number {
  const rules = allRules(policies);
  const settings = lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, rules, project.yodel?.path);
  // The schema checks of the project's dialect only: the other dialect's never run on its migrations.
  // One not set in yodel.config.ts takes chant.config.ts lint.rules' level, else the level the check gives each finding.
  const chantRules = (project.config as { lint?: { rules?: Record<string, unknown> } }).lint?.rules;
  const rows = Object.values(rules)
    .filter((r) => !r.schema || r.dialect === undefined || r.dialect === project.dialect)
    .map((r) => ({ ...r, configured: settings.levels[r.id] ?? (r.schema ? chantLevel(chantRules?.[r.id]) : undefined) ?? r.level}));
  const own = new Set(rows.filter((r) => r.schema === true && settings.levels[r.id] === undefined && chantLevel(chantRules?.[r.id]) === undefined).map((r) => r.id));
  if (json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const marks = [own.has(r.id) ? "the check's level" : r.configured, r.silenceable ? "silenceable" : "", r.dialect ?? ""].filter(Boolean).join(", ");
    io.out(`${r.id.padEnd(width)}  ${marks}\n${" ".repeat(width + 2)}${r.summary}\n`);
  }
  return 0;
}

/** `yodel lint`; the exit codes are in `help`. */
export const lint: Command = {
  name: "lint",
  summary: "check the migrations against the lint rules",
  implemented: true,
  run: (args, io) =>
    guarded("lint", io, args, help, async () => {
      const a = parseLintArgs(args);
      const project = await loadProject(a.dir);
      const policies = await loadPolicies(project);
      if (a.rules) return listRules(io, a.json, project, policies);
      const settings = lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, allRules(policies), project.yodel?.path);
      if (!hasMigrations(project)) return declarativeLintRun(project, a, settings, policies, io);
      const dir = migrationsDir(project);

      const options: LintOptions = { dialect: project.dialect, project, settings, rules: projectRules, policies };
      if (a.env !== undefined) {
        const env = resolveEnvironment(project, a.env);
        const ordered = scanMigrations(dir).ordered;
        if (ordered) {
          const venv = await openVersioned(project, env);
          const { status } = await inspect(venv, ordered, { sync: false });
          options.history = { environment: env.name, status };
        } else if (!a.json) {
          io.err(`yodel lint: the migrations directory is not one chain, so it is not compared with ${env.name}'s history; fix the findings below first\n`);
        }
      }

      if (a.update.length > 0) {
        const byId = new Map(scanMigrations(dir).migrations.map((m) => [m.id, m]));
        for (const id of a.update) {
          const m = byId.get(id);
          if (!m) throw new YodelError(`--update-checksum ${id}: no such migration in ${dir}`);
          const applied = options.history?.status.applied.some((x) => x.id === id);
          if (applied) throw new YodelError(`--update-checksum ${id}: it is applied in ${String(options.history?.environment)}; record an intended edit there with yodel repair ${id} --reason ... ${String(options.history?.environment)}`);
          if (isHandWritten(m.document)) {
            // A hand-written migration (#248): its statements come from migration.sql.
            const parent = m.document.parent === null ? undefined : byId.get(m.document.parent);
            const recorded = await recordHandWritten(m, parent?.document.schema, async () => {
              const build = await buildSchema(project);
              try {
                return build.output;
              } finally {
                build.dispose();
              }
            });
            const doc = { ...(JSON.parse(m.files.json) as Record<string, unknown>), ...recorded.document };
            writeFileSync(join(m.dir, MIGRATION_JSON), serializeDocument(doc));
            m.files = { ...m.files, json: serializeDocument(doc) };
            m.document = recorded.document;
            if (!a.json) {
              io.err(
                `${id}: ${String(recorded.statements)} hand-written statement${recorded.statements === 1 ? "" : "s"} recorded; ` +
                  (recorded.changesSchema ? "the schema after it is the current build of src/ (yodel lint --replay shows the statements give it)\n" : "data only, so the schema after it is its parent's\n"),
              );
            }
          }
          const changed = updateChecksum(m);
          if (!a.json) io.err(changed ? `${id}: checksum ${changed.from} is now ${changed.to}\n` : `${id}: its checksum already matches its files\n`);
        }
      }

      let replay: ReplayResult | undefined;
      if (a.replay !== undefined) {
        const env = resolveEnvironment(project, a.replay);
        if (scanMigrations(dir).ordered) {
          // A target that is not fresh throws here, exit 1, before anything is linted or run.
          replay = await replayHistory(project, env, { reset: a.reset, resetShared: a.resetShared, keep: a.keep, log: (l) => { io.err(`replay: ${l}\n`); } });
          options.rules = [...projectRules, replayRule(replay)];
        } else {
          io.err(`yodel lint: the migrations directory is not one chain, so it is not replayed; fix the findings below first\n`);
        }
      }

      const report = await lintMigrations(dir, options);
      return emit(report, a, project, io, replay);
    }),
};

/** Prints the report as `a` asks, writes the code quality report for --format gitlab, and returns the exit code. */
function emit(report: LintReport, a: LintArgs, project: Project, io: Io, replay?: ReplayResult): number {
  if (a.json) io.out(`${JSON.stringify({ ...lintJson(report), ...(replay ? { replay: replayJson(replay) } : {}) }, null, 2)}\n`);
  else {
    io.out(`${replay ? `${renderReplay(replay)}\n` : ""}${renderLint(report)}`);
    // The forge's checkout, which a forge's file paths are relative to; the project's directory elsewhere.
    const root = process.env.GITHUB_WORKSPACE || process.env.CI_PROJECT_DIR || project.dir;
    if (a.format === "github") io.out(workflowCommands(report, root));
    if (a.format === "gitlab") writeFileSync(resolve(a.output), `${JSON.stringify(codeQuality(report, root), null, 2)}\n`);
  }
  return lintExitCode(report);
}

/**
 * `yodel lint` in a project with no migrations (#249): the lexicon's schema
 * checks, the project's own checks and lint.naming over the build of src/,
 * offline; with --env, also the statement rules over the changes the
 * declared schema plans against that environment's live database.
 */
async function declarativeLintRun(project: Project, a: LintArgs, settings: LintSettings, policies: readonly PostSynthCheck[], io: Io): Promise<number> {
  const versionedOnly = [...(a.replay !== undefined ? ["--replay"] : []), ...(a.update.length > 0 ? ["--update-checksum"] : [])];
  if (versionedOnly.length > 0) throw new YodelError(`${versionedOnly.join(" and ")} ${versionedOnly.length === 1 ? "reads" : "read"} a migrations directory, and ${project.dir} has no migrations/ directory with a migration; on the declarative path, yodel lint --env <env> lints the plan against <env>`);
  const build = await buildSchema(project, { empty: true });
  try {
    // A project that declares nothing yet has no schema to check and nothing to plan.
    if (build.output.objects.length === 0) {
      if (a.env !== undefined) throw new YodelError(`${project.sourceDir} declares nothing: there is no declared schema to plan against ${a.env}`);
      return emit(declarativeLint({ project, settings, policies, schema: [] }), a, project, io);
    }
    const chantRules = (project.config as { lint?: { rules?: Record<string, unknown> } }).lint?.rules;
    const schema = declaredSchemaFindings(build.output, { settings, chantRules, policies, env: a.env });
    let plan: { environment: string; findings: ReturnType<typeof changeFindings> } | undefined;
    if (a.env !== undefined) {
      const env = resolveEnvironment(project, a.env);
      const refusal = declarativeRefusal(project, env.name);
      if (refusal) throw refusal;
      const planned = await planEnvironment(project, env, build);
      plan = { environment: env.name, findings: changeFindings(project.dialect, declaredChanges(planned, build), planned.refused) };
    }
    return emit(declarativeLint({ project, settings, policies, schema, plan }), a, project, io);
  } finally {
    build.dispose();
  }
}
