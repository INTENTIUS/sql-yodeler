/**
 * The pull request's check on chant's check moment (#294, chant#4556).
 *
 * yodel's checks (the pipelines up to date, sql-types.d.ts up to date,
 * `yodel lint`, the replay check, `yodel test`, `yodel check`) become hook
 * presets in `ci.hooks.check` of the project's workspace declaration
 * (chant.workspace.json), beside the SQL tools a team already runs: squawk
 * and sqlfluff, off unless yodel.config.ts `ci.tools` names them. yodel
 * holds no rule of its own that duplicates those tools.
 *
 * The lint job then runs `yodel chant ci check --base <base>`, and chant
 * reads the hooks from the declaration at the pull request's base, so a
 * pull request cannot remove a required check. chant runs each hook with no
 * forge token, OIDC request variables or cloud credentials, and writes
 * `.chant/check/check-hooks.json` with each hook's name, result and exit
 * code. A hook inherits the job's output, so `yodel lint --format github`'s
 * annotations still reach the pull request; on GitLab the lint preset
 * writes the code quality report the job keeps as its artifact.
 *
 * The installed chant has the check moment from its release after 0.124.51.
 * {@link chantCheckHooks} imports `@intentius/chant/components/check-hooks`
 * lazily, with the specifier in a variable; without it, or in a project
 * with no workspace declaration, the lint job runs the commands itself, as
 * before.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckTool } from "../config/define.js";

/** A hook on chant's check moment, the parts yodel writes. */
export interface CheckHook {
  name: string;
  command: string[];
}

/** The parts of chant's `components/check-hooks` yodel calls. */
export interface ChantCheckHooks {
  writeCiHook(root: string, moment: "check", hook: CheckHook, opts?: { member?: string }): { file: string; replaced: boolean };
  runCheckHooks(options: { base: string; targets?: readonly string[]; cwd?: string }): { status: "passed" | "failed" | "none" };
}

let api: Promise<ChantCheckHooks | undefined> | undefined;

/** chant's check moment, once, or undefined when the installed chant has none (a release before chant#4556). */
export function chantCheckHooks(): Promise<ChantCheckHooks | undefined> {
  api ??= (async () => {
    const specifier = "@intentius/chant/components/check-hooks";
    let m: Partial<ChantCheckHooks> | undefined;
    try {
      m = (await import(specifier)) as Partial<ChantCheckHooks>;
    } catch {
      return undefined;
    }
    return typeof m.writeCiHook === "function" && typeof m.runCheckHooks === "function" ? (m as ChantCheckHooks) : undefined;
  })();
  return api;
}

/** The workspace declaration files chant reads, in its order. */
export const DECLARATION_FILES = ["chant.workspace.json", "chant.workspace.jsonc"] as const;

/** The project's workspace declaration, if it has one. */
export function declarationFile(dir: string): string | undefined {
  return DECLARATION_FILES.find((f) => existsSync(join(dir, f)));
}

/** The names of the presets yodel writes, so a render can tell its own hooks from the project's. */
export const YODEL_PRESETS = ["yodel-ci-check", "yodel-sql-types", "yodel-lint", "yodel-replay", "yodel-test", "yodel-check"] as const;

/** What the presets are made from: the commands the lint job runs today, and what the project has. */
export interface PresetInput {
  dialect: "clickhouse" | "postgres";
  commands: { ci: string; types: string; lint: string; replay: string; test: string; check: string };
  typedColumns: boolean;
  replay: boolean;
  tests: boolean;
  check: boolean;
  tools: readonly CheckTool[];
}

/** A command line as a hook's argv. The lines are yodel's own, with no shell syntax, so splitting on spaces is exact. */
const argv = (line: string): string[] => line.split(" ").filter((w) => w !== "");

/** squawk lints Postgres migrations only. */
export const squawkPreset = (): CheckHook => ({ name: "squawk", command: ["sh", "-c", "squawk migrations/*/migration.sql"] });

/** sqlfluff over the migrations directory, in the project's dialect. */
export const sqlfluffPreset = (dialect: "clickhouse" | "postgres"): CheckHook => ({ name: "sqlfluff", command: ["sqlfluff", "lint", "migrations", "--dialect", dialect] });

/**
 * The check hooks, in the order the lint job ran them: yodel's checks, then
 * the replay server's (the job waits for the server before the hooks run),
 * then the tools the project named. squawk on a ClickHouse project is
 * refused.
 */
export function checkPresets(p: PresetInput): CheckHook[] {
  if (p.tools.includes("squawk") && p.dialect !== "postgres") throw new Error("yodel.config.ts: ci.tools: squawk lints Postgres migrations only, and this project's dialect is clickhouse; use sqlfluff");
  return [
    { name: "yodel-ci-check", command: argv(p.commands.ci) },
    ...(p.typedColumns ? [{ name: "yodel-sql-types", command: argv(p.commands.types) }] : []),
    { name: "yodel-lint", command: argv(p.commands.lint) },
    ...(p.replay ? [{ name: "yodel-replay", command: argv(p.commands.replay) }] : []),
    ...(p.replay && p.tests ? [{ name: "yodel-test", command: argv(p.commands.test) }] : []),
    ...(p.replay && p.check ? [{ name: "yodel-check", command: argv(p.commands.check) }] : []),
    ...(p.tools.includes("squawk") ? [squawkPreset()] : []),
    ...(p.tools.includes("sqlfluff") ? [sqlfluffPreset(p.dialect)] : []),
  ];
}

/**
 * The project's workspace declaration with `hooks` in `ci.hooks.check`, as
 * chant's `writeCiHook` writes them (the file's formatting kept, a hook of
 * the same name replaced). Written on a copy, so rendering touches nothing;
 * `yodel ci` writes the result, and `yodel ci --check` compares it.
 */
export function declarationWithHooks(chant: ChantCheckHooks, dir: string, file: string, hooks: readonly CheckHook[]): string {
  const scratch = mkdtempSync(join(tmpdir(), "yodel-check-hooks-"));
  try {
    copyFileSync(join(dir, file), join(scratch, file));
    for (const hook of hooks) chant.writeCiHook(scratch, "check", hook);
    return readFileSync(join(scratch, file), "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
