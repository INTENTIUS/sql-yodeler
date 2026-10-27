import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Project } from "../project.js";
import { readChain } from "../versioned/index.js";
import { loadTests, runTests, testFiles, TESTS_DIR } from "../testing/run.js";
import { renderTests, testExitCode, testJson, testJunit } from "../testing/report.js";

const usage = "usage: yodel test [--env <env>] [--run <regexp>] [--reset] [--reset-shared <profile>]... [--keep] [--json] [--junit <file>] [--dir <project>]";

const help = `${usage}

Runs the cases in tests/*.test.ts against databases built from the
migrations on a throwaway server: the profile --env names (default: test,
else replay). A case seeds data at a migration and checks it after the
migrations that follow (backfills included), or checks the schema the newest
migration leaves (a view's rows, a function's result, a constraint that
refuses a row):

  import { defineTests, expectError, expectRows, expectValue } from "@intentius/sql-yodeler";

  export default defineTests([
    {
      name: "fill-country fills every country",
      at: "20261010T0530-add-source",          // seed after this migration
      seed: ["INSERT INTO shop.events (id, kind, at) VALUES (1, 'view', now())"],
      expect: [expectValue("SELECT count() FROM shop.events WHERE country = ''", 0)],
    },
  ]);

Per case, the databases (or schemas) the history names are emptied, the
migrations up to at (default: the newest) are replayed as yodel lint
--replay replays them (backfills skipped: there are no rows yet), the seed
runs, the migrations after at up to through (default: the newest) run with
every step, backfills included, and each expectation is checked. Values
compare as text. Nothing is written to a history.

It never runs against an environment yodel applies to: a target whose
history table holds a row is refused, and so is one that already holds what
the history names (unless --reset), or one another profile on the same
server names (unless --reset-shared <profile>).

Options:
  --env <env>             the throwaway server's profile (default: test, else
                          replay)
  --run <regexp>          only the cases whose name matches
  --reset                 drop what the history names first when it is there.
                          Destructive: never against a server whose data
                          matters
  --reset-shared <profile>
                          run even though <profile> binds the same server and
                          names one of those databases or schemas (repeatable)
  --keep                  leave the last case's database in place
  --json                  print the outcome as JSON
  --junit <file>          also write the outcome as JUnit XML to <file>
  -C, --dir <dir>         the project directory (default: the working directory)

Exit codes:
  0  every case passed (or there is no case)
  1  a case failed, or could not run (a migration or seed statement failed);
     refused, nothing run: the target has a migration history, already holds
     what the history names (no --reset), or another profile names it; or
     anything else: a test file that does not load, a bad config, a server
     that does not answer
`;

interface TestArgs {
  env: string | undefined;
  run: RegExp | undefined;
  reset: boolean;
  resetShared: string[];
  keep: boolean;
  json: boolean;
  junit: string | undefined;
  dir: string;
}

function parseTestArgs(args: string[]): TestArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        env: { type: "string" },
        run: { type: "string" },
        reset: { type: "boolean" },
        "reset-shared": { type: "string", multiple: true },
        keep: { type: "boolean" },
        json: { type: "boolean" },
        junit: { type: "string" },
        dir: { type: "string", short: "C" },
      },
    });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const v = parsed.values;
  let run: RegExp | undefined;
  if (typeof v.run === "string") {
    try {
      run = new RegExp(v.run);
    } catch (e) {
      throw new YodelError(`--run ${v.run}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return {
    env: typeof v.env === "string" ? v.env : undefined,
    run,
    reset: v.reset === true,
    resetShared: Array.isArray(v["reset-shared"]) ? v["reset-shared"].filter((r): r is string => typeof r === "string") : [],
    keep: v.keep === true,
    json: v.json === true,
    junit: typeof v.junit === "string" ? v.junit : undefined,
    dir: typeof v.dir === "string" ? v.dir : process.cwd(),
  };
}

/** The profile a run uses when --env is not given: test, else replay. */
function defaultEnv(project: Project): string {
  const profiles = Object.keys(project.config.sql?.profiles ?? {});
  const found = ["test", "replay"].find((p) => profiles.includes(p));
  if (!found) throw new YodelError(`yodel test runs on a throwaway server: name its profile with --env (chant.config.ts declares no sql.profiles.test or sql.profiles.replay)`);
  return found;
}

/** `yodel test`; the exit codes are in `help`. */
export const test: Command = {
  name: "test",
  summary: "run tests/*.test.ts on databases built from the migrations",
  implemented: true,
  run: (args, io) =>
    guarded("test", io, args, help, async () => {
      const a = parseTestArgs(args);
      const project = await loadProject(a.dir);
      const files = testFiles(project.dir);
      if (files.length === 0) {
        if (!a.json) io.out(`No test files: ${TESTS_DIR}/*.test.ts holds none.\n`);
        else io.out(`${JSON.stringify({ files: [], summary: { passed: 0, failed: 0, errors: 0 }, cases: [] }, null, 2)}\n`);
        return 0;
      }
      const tests = await loadTests(project.dir, files);
      // A directory that is not one chain is refused (exit 1) before anything runs.
      readChain(project);
      const env = resolveEnvironment(project, a.env ?? defaultEnv(project));
      // A rebuild step's executor prints its SQL to stdout: while the cases run, stdout goes to stderr, so --json stays one document.
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = process.stderr.write.bind(process.stderr);
      let run: Awaited<ReturnType<typeof runTests>>;
      try {
        run = await runTests(project, env, tests, {
          ...(a.run ? { run: a.run } : {}),
          reset: a.reset,
          resetShared: a.resetShared,
          keep: a.keep,
          log: (l) => { io.err(`test: ${l}\n`); },
        });
      } finally {
        process.stdout.write = write;
      }
      if (a.junit !== undefined) {
        const path = resolve(a.junit);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, testJunit(run));
      }
      if (a.json) io.out(`${JSON.stringify(testJson(run), null, 2)}\n`);
      else io.out(renderTests(run));
      return testExitCode(run);
    }),
};
