import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { CODE_QUALITY_FILE, codeQuality, FORGE_FORMAT, forgeFormat, LINT_FORMATS, LINT_RULES, SCHEMA_RULES, lintExitCode, lintJson, lintSettings, renderLint, workflowCommands, type LintFormat } from "../lint/index.js";
import { loadPolicies, policyRules } from "../lint/policies.js";
import { detectTool, readForeignDir, TOOLS, type Tool } from "../check/readers.js";
import { openCheckServer, runCheck } from "../check/run.js";

const usage = "usage: yodel check [<dir>] [--tool <tool>] [--env <env>] [--base <ref> | --all] [--reset] [--keep] [--json | --format <format> [--output <file>]] [--dir <project>]";

const help = `${usage}

Checks another tool's migrations with yodel's lint, so a team can try yodel
on its pull requests and keep golang-migrate, goose, Flyway or dbmate. It
reads <dir> (yodel.config.ts check.dir when not given), runs its migrations
in the tool's order into a throwaway server, and lints each one that is new
since the base: yodel's classifier names what it does to the schema (a drop,
a table rewrite, a lock, a statement that can fail on the rows already
there), and every yodel lint rule runs on it, chant.config.ts lint.policies
included. It applies nothing to an environment: the throwaway server's
schemas or databases are emptied before and after.

Tools (detected from the file names when --tool is not given):
  golang-migrate  <version>_<title>.up.sql; the .down.sql files are not read
  goose           <version>_<name>.sql, the -- +goose Up section; a
                  StatementBegin/StatementEnd block is one statement.
                  Go migrations are refused: their code is not SQL
  flyway          the locations of the flyway.toml or flyway.conf in <dir>
                  or above it (else <dir>), subfolders included: the newest
                  B<version>__ baseline, then V<version>__<description>.sql
                  by version, then R__<description>.sql by description,
                  placeholders substituted. Undo files and callbacks are
                  not read; Java and Kotlin migrations are refused
  dbmate          <version>_<name>.sql, the -- migrate:up section

Silencing: a line in the migration file,
  -- yodel:allow <rule> <reason>
silences that rule (destructive, pg-rewrite, pg-lock, data-dependent,
ch-mutation, a schema check's id, a policy's id) for that file. The reason
is required.

Options:
  --tool <tool>         ${TOOLS.join(", ")} (default: detected)
  --env <env>           the profile bound to the throwaway server (default:
                        yodel.config.ts check.env, else replay). Its schemas
                        (Postgres) or databases (ClickHouse) are where the
                        migrations put their objects
  --base <ref>          the files added or changed since <ref> are the new
                        ones, linted; the rest only run (default:
                        origin/main)
  --all                 lint every migration
  --reset               empty the profile's schemas or databases first when
                        they hold anything. Destructive: never against a
                        server whose data matters
  --keep                leave the replayed schema in place
  --json                the findings as JSON (--format json)
  --format <format>     text, json, github, gitlab or forge, as yodel lint
                        prints them; github and gitlab put each finding on
                        its line of the migration file, and forge picks the
                        one of the forge the job runs on
  --output <file>       with --format gitlab: where the code quality report
                        goes (default ${CODE_QUALITY_FILE})
  -C, --dir <dir>       the project directory (default: the working directory)

Exit codes:
  0  no errors
  1  at least one error, or a migration the server refused; the throwaway
     server's scope holds something and --reset was not given; or the check
     could not run: no directory, an unknown tool, a server that does not
     answer
`;

interface CheckArgs {
  dir: string | undefined;
  tool: Tool | undefined;
  env: string | undefined;
  base: string;
  all: boolean;
  reset: boolean;
  keep: boolean;
  json: boolean;
  format: LintFormat;
  output: string;
  project: string;
}

function parseCheckArgs(args: string[]): CheckArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        tool: { type: "string" },
        env: { type: "string" },
        base: { type: "string" },
        all: { type: "boolean" },
        reset: { type: "boolean" },
        keep: { type: "boolean" },
        json: { type: "boolean" },
        format: { type: "string" },
        output: { type: "string" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const v = parsed.values;
  if (parsed.positionals.length > 1) throw new YodelError(`one directory, not ${String(parsed.positionals.length)}\n${usage}`);
  const tool = typeof v.tool === "string" ? v.tool : undefined;
  if (tool !== undefined && !(TOOLS as readonly string[]).includes(tool)) throw new YodelError(`--tool ${tool}: it is ${TOOLS.join(", ")}\n${usage}`);
  const asked = typeof v.format === "string" ? v.format : v.json === true ? "json" : "text";
  // --format forge (#294): the job's own forge, so one check hook serves every forge.
  const format = asked === FORGE_FORMAT ? forgeFormat() : asked;
  if (!(LINT_FORMATS as readonly string[]).includes(format)) throw new YodelError(`--format ${format}: it is ${LINT_FORMATS.join(", ")}\n${usage}`);
  if (v.json === true && format !== "json") throw new YodelError(`--json is --format json; give one of them\n${usage}`);
  if (typeof v.output === "string" && format !== "gitlab" && asked !== FORGE_FORMAT) throw new YodelError(`--output goes with --format gitlab\n${usage}`);
  if (v.all === true && typeof v.base === "string") throw new YodelError(`--all lints every migration; --base picks the new ones. Give one\n${usage}`);
  return {
    dir: parsed.positionals[0],
    tool: tool as Tool | undefined,
    env: typeof v.env === "string" ? v.env : undefined,
    base: typeof v.base === "string" ? v.base : "origin/main",
    all: v.all === true,
    reset: v.reset === true,
    keep: v.keep === true,
    json: format === "json",
    format: format as LintFormat,
    output: typeof v.output === "string" ? v.output : CODE_QUALITY_FILE,
    project: typeof v.dir === "string" ? v.dir : process.cwd(),
  };
}

/** The files of `dir` added or changed since `base`, relative to `dir`: the new migrations. */
export function changedSince(dir: string, base: string): Set<string> {
  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new YodelError(`--base ${base}: no such commit here; fetch it (git fetch origin), name another with --base, or lint every migration with --all`);
  }
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  return new Set([
    ...lines(git(["diff", "--name-only", "--relative", "--diff-filter=AMR", base, "--", "."])),
    ...lines(git(["ls-files", "--others", "--exclude-standard", "--", "."])),
  ]);
}

/** The dialect's statement splitter. */
async function splitter(project: Project): Promise<(sql: string) => string[]> {
  if (project.dialect === "postgres") {
    const { splitStatements } = await import("@intentius/chant-lexicon-sql/postgres/apply/statements");
    return (sql) => splitStatements(sql).map((s) => s.text);
  }
  const { splitStatements } = await import("@intentius/chant-lexicon-sql/clickhouse/import/ir");
  return (sql) => splitStatements(sql);
}

/** `yodel check`; the exit codes are in `help`. */
export const check: Command = {
  name: "check",
  summary: "lint a golang-migrate, goose, Flyway or dbmate directory",
  implemented: true,
  run: (args, io) =>
    guarded("check", io, args, help, async () => {
      const a = parseCheckArgs(args);
      const project = await loadProject(a.project);
      const configured = project.yodel?.config.check;
      const dirArg = a.dir ?? configured?.dir;
      if (dirArg === undefined) throw new YodelError(`no directory: name it (yodel check <dir>) or set yodel.config.ts check.dir\n${usage}`);
      const dir = resolve(a.dir !== undefined ? process.cwd() : project.dir, dirArg);
      const tool = a.tool ?? configured?.tool ?? detectTool(dir, project.dir);
      if (tool === undefined) throw new YodelError(`${dir}: its files are not golang-migrate's, goose's, Flyway's or dbmate's as yodel reads them; name the tool with --tool`);
      const split = await splitter(project);

      const policies = await loadPolicies(project);
      const settings = lintSettings(project.yodel?.config.lint as Record<string, unknown> | undefined, { ...LINT_RULES, ...SCHEMA_RULES, ...policyRules(policies) }, project.yodel?.path);
      const env = resolveEnvironment(project, a.env ?? configured?.env ?? "replay");
      const server = await openCheckServer(project, env);
      let result;
      try {
        // Flyway's ${flyway:defaultSchema} falls back to the replay scope's.
        const read = readForeignDir(dir, tool, split, { stopAt: project.dir, defaults: { defaultSchema: server.defaults.defaultSchema ?? server.defaults.defaultDatabase ?? server.scope[0] } });
        const root = read.root;
        const { migrations } = read;
        if (migrations.length === 0) throw new YodelError(`${dir}: no ${tool} migrations`);
        const fresh = a.all ? undefined : changedSince(root, a.base);
        const isNew = (m: { file: string }) => fresh === undefined || fresh.has(m.file);
        if (!a.json) io.err(`yodel check: ${tool}${read.config ? ` (${relative(process.cwd(), read.config) || read.config})` : ""}, ${String(migrations.length)} migration${migrations.length === 1 ? "" : "s"} in ${root}, ${String(migrations.filter(isNew).length)} new; replaying into ${server.where}\n`);
        result = await runCheck(project, env, server, migrations, {
          dir: root,
          isNew,
          reset: a.reset,
          keep: a.keep,
          lint: { dialect: project.dialect, project, settings, policies },
          log: (l) => {
            if (!a.json) io.err(`  ${l}\n`);
          },
        });
      } finally {
        await server.close();
      }
      const { report } = result;
      if (a.json) io.out(`${JSON.stringify({ tool, ...lintJson(report), checked: result.checked }, null, 2)}\n`);
      else {
        io.out(renderLint(report).replace(/^A statement rule can be silenced[^\n]*\n[^\n]*\n/m, "A rule can be silenced for one migration file, with a reason:\n  a line `-- yodel:allow <rule> <reason>` in that file\n"));
        const root = process.env.GITHUB_WORKSPACE || process.env.CI_PROJECT_DIR || project.dir;
        if (a.format === "github") io.out(workflowCommands(report, root));
        if (a.format === "gitlab") writeFileSync(resolve(a.output), `${JSON.stringify(codeQuality(report, root), null, 2)}\n`);
      }
      return lintExitCode(report);
    }),
};
