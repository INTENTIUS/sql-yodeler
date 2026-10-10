import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { scanMigrations } from "../migrations/index.js";
import { inspect, migrationsDir, openVersioned } from "../versioned/index.js";
import { LINT_RULES, lintExitCode, lintJson, lintMigrations, lintSettings, renderLint, updateChecksum, type LintOptions, type LintRule } from "../lint/index.js";
import { projectRules, REPLAY_RULE, replayRule } from "../lint/project-rules.js";
import { renderReplay, replayHistory, replayJson, type ReplayResult } from "../replay/index.js";

const usage = "usage: yodel lint [--env <env>] [--replay <env> [--reset] [--keep]] [--json] [--dir <project>] [--update-checksum <id>]... [--rules]";

const help = `${usage}

Checks the migrations directory against every lint rule, offline: no server
and no dev database. Every rule is free and runs in CI on every pull request.

Rules (yodel lint --rules lists them with their levels):
  fork               two migrations follow the same parent (yodel rebase)
  directory          not one readable chain: a bad name or file, a missing
                     parent, a cycle, a migration of another dialect
  checksum           a migration's files no longer hash to its checksum
  unreadable-object  an object in a recorded schema, or a step, the sql
                     lexicon cannot read or classify; an error, never skipped
  destructive        a drop that removes data for good
  pg-rewrite         Postgres: a rewrite or full scan under ACCESS EXCLUSIVE
  pg-lock            Postgres: writes blocked for a whole index build or scan
  ch-mutation        ClickHouse: a mutation rewriting parts, no rollback
  ch-rebuild         ClickHouse: a rebuild (ClickHouseRebuildOp)
  refused-step       a step yodel apply refuses (a manual step, an Op it
                     does not run)
  migration-sql      migration.sql does not hold a statement migration.json
                     records (apply runs migration.json's)
  silence            a yodel:allow line that is wrong or silences nothing
  replay             with --replay <env>: the history, replayed into a fresh
                     database on <env>'s server, does not give a migration's
                     recorded schema (names the first that differs)

Silencing: a line above a statement in its migration.sql,
  -- yodel:allow <rule> <reason>
silences that statement rule (destructive, pg-rewrite, pg-lock,
ch-mutation, ch-rebuild) for that one statement. The reason is required,
and yodel apply records the rule, the statement and the reason in every
history row the migration writes (the silences column). Adding the line
changes the migration's checksum: for a migration not yet applied anywhere,
record the new one with --update-checksum <id>.

Levels: yodel.config.ts lint.rules sets a rule to "error", "warning" or
"off", e.g. lint: { rules: { "ch-mutation": "warning" } }. fork, directory,
checksum and unreadable-object are always errors.

Options:
  --env <env>             also compare with <env>'s history: a
                          checksum error is then an applied migration whose
                          files changed since it ran; a pending migration's
                          edit is a warning
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
  --keep                  with --replay: leave the replayed database in place
  --rules                 list the rules and their levels, and exit
  --json                  print the findings as JSON
  -C, --dir <dir>         the project directory (default: the working directory)

Exit codes:
  0  no errors (warnings and silenced findings do not fail)
  3  at least one error (a replay that differs counts)
  4  --replay: the target already holds what the history names, and --reset
     was not given; nothing was run
  1  lint could not run: a bad config, an unknown migration for
     --update-checksum, a server that does not answer (--env)
`;

interface LintArgs {
  env: string | undefined;
  replay: string | undefined;
  reset: boolean;
  keep: boolean;
  json: boolean;
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
        keep: { type: "boolean" },
        json: { type: "boolean" },
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
  if (replay === undefined && (v.reset === true || v.keep === true)) throw new YodelError(`--reset and --keep go with --replay <env>\n${usage}`);
  return {
    env: typeof v.env === "string" ? v.env : undefined,
    replay,
    reset: v.reset === true,
    keep: v.keep === true,
    json: v.json === true,
    dir: typeof v.dir === "string" ? v.dir : process.cwd(),
    update: Array.isArray(update) ? update.filter((u): u is string => typeof u === "string") : [],
    rules: v.rules === true,
  };
}

function allRules(): Record<string, LintRule> {
  return { ...LINT_RULES, ...Object.fromEntries(projectRules.map((r) => [r.rule.id, r.rule])), [REPLAY_RULE.id]: REPLAY_RULE };
}

function listRules(io: Io, json: boolean, project: Project): number {
  const rules = allRules();
  const settings = lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, rules, project.yodel?.path);
  const rows = Object.values(rules).map((r) => ({ ...r, configured: settings.levels[r.id] ?? r.level }));
  if (json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) {
    const marks = [r.configured, r.silenceable ? "silenceable" : "", r.dialect ?? ""].filter(Boolean).join(", ");
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
      if (a.rules) return listRules(io, a.json, project);
      const settings = lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, allRules(), project.yodel?.path);
      const dir = migrationsDir(project);

      const options: LintOptions = { dialect: project.dialect, project, settings, rules: projectRules };
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
          const changed = updateChecksum(m);
          if (!a.json) io.err(changed ? `${id}: checksum ${changed.from} is now ${changed.to}\n` : `${id}: its checksum already matches its files\n`);
        }
      }

      let replay: ReplayResult | undefined;
      if (a.replay !== undefined) {
        const env = resolveEnvironment(project, a.replay);
        if (scanMigrations(dir).ordered) {
          // A target that is not fresh throws here, exit 4, before anything is linted or run.
          replay = await replayHistory(project, env, { reset: a.reset, keep: a.keep, log: (l) => { io.err(`replay: ${l}\n`); } });
          options.rules = [...projectRules, replayRule(replay)];
        } else {
          io.err(`yodel lint: the migrations directory is not one chain, so it is not replayed; fix the findings below first\n`);
        }
      }

      const report = await lintMigrations(dir, options);
      if (a.json) io.out(`${JSON.stringify({ ...lintJson(report), ...(replay ? { replay: replayJson(replay) } : {}) }, null, 2)}\n`);
      else io.out(`${replay ? `${renderReplay(replay)}\n` : ""}${renderLint(report)}`);
      return lintExitCode(report);
    }),
};
