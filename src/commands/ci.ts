import { join, resolve } from "node:path";
import { planFile, planRemoval, staleGeneratedFiles, writePlannedFiles } from "@intentius/chant/planned-files";
import type { Command } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, YodelError } from "../project.js";

const usage = "usage: yodel ci [--check] [--dir <project>]\n       yodel ci --replay [--dir <project>] [-- <yodel lint options>]\n       yodel ci --fetch-ledger [--dir <project>]";

const help = `${usage}

Renders the project's CI pipelines for GitHub Actions, GitLab CI and
Forgejo Actions from chant.config.ts (the environments, in profile order),
yodel.config.ts (waves, ci) and ops/ (each environment's migrate and watch
Ops), each declared with chant's lexicons:

  yodel-pr      on a pull request: yodel ci --check, yodel lint, the replay
                check into a throwaway server, and the plan comment per
                environment
  yodel-apply   on a push to main: one job per wave (yodel-waves.json)
  yodel-apply-plans
                on a pull request, when a wave's approval is pr-review:
                chant run wave --record-plans records the plan each wave
                makes at the head, for the review to approve (on GitLab, the
                merge request job yodel-apply-record-plans)
  watch-<env>   each environment's drift watch, on its schedule

The pipelines come from the installed yodel, so upgrading yodel and running
yodel ci again brings its fixes to the project; yodel ci --check then fails
until the new files are committed.

A pipeline file that carries yodel ci's header and that yodel ci no longer
renders (a forge dropped from ci.forges, respond.new or respond.rebase
turned off) is removed; --check names it.

yodel.config.ts ci:
  forges   the forges to render for (default github, gitlab and forgejo)
  jobs     a module (such as "ci/jobs.ts") exporting the project's own jobs,
           declared with chant: actions (github lexicon Jobs, for GitHub and
           Forgejo) and gitlab (gitlab lexicon Jobs). They are added to the
           pull request pipeline after yodel's jobs, on every render.
  image    the CI image every job runs in, pinned by its digest
  resume   { schedule: "<cron>" }: a scheduled yodel-apply-resume job that
           starts again an apply wave whose approval has arrived (chant run
           resume); it approves nothing. GitHub uses the job's token
           (actions: write), Forgejo the CHANT_FORGE_TOKEN secret
           (write:repository), GitLab a pipeline schedule you create, with
           GITLAB_TOKEN (api scope, Developer)
  apply    false: no apply pipeline (no yodel-waves.json, yodel-apply or
           yodel-apply-plans, no GitLab apply stages). The pull request
           checks and the watches remain, all with readers; --check does
           not expect the apply files. Refused with a pr-review wave or
           resume, which need the apply pipeline

Options:
  --check          write nothing; exit 1 naming each file that differs from
                   what yodel ci renders
  --replay         the lint job's replay check on this machine: a throwaway
                   server started with Docker from the job's image, the
                   replay profile pointed at it, yodel lint --replay replay
                   --reset, and the server removed. Options after -- go to
                   yodel lint. The exit code is yodel lint's
  --fetch-ledger   what each job runs before it reads an approval: fetch
                   chant/lifecycle through chant's reader, which fetches the
                   way chant's writer expects and never moves the ref its
                   push leases against. Exit 1 only when this checkout's
                   branch has diverged from the remote's
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  written, or (--check) every file is up to date
  1  (--check) a file is stale, missing or no longer rendered; anything
     else failed
`;

interface CiArgs {
  dir: string;
  check: boolean;
  replay: boolean;
  fetchLedger: boolean;
  rest: string[];
}

function parseCiArgs(args: readonly string[]): CiArgs {
  const out: CiArgs = { dir: process.cwd(), check: false, replay: false, fetchLedger: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.rest = args.slice(i + 1);
      break;
    }
    if (a === "--check") out.check = true;
    else if (a === "--replay") out.replay = true;
    else if (a === "--fetch-ledger") out.fetchLedger = true;
    else if (a === "--dir" || a === "-C") {
      const v = args[++i];
      if (v === undefined) throw new YodelError(`${a} needs a directory\n${usage}`);
      out.dir = v;
    } else if (a?.startsWith("--dir=")) out.dir = a.slice("--dir=".length);
    else throw new YodelError(`unknown argument ${String(a)}\n${usage}`);
  }
  if ([out.check, out.replay, out.fetchLedger].filter(Boolean).length > 1) throw new YodelError(`--check, --replay and --fetch-ledger are three things; give one\n${usage}`);
  if (out.rest.length > 0 && !out.replay) throw new YodelError(`options after -- are for --replay\n${usage}`);
  return out;
}

/** `yodel ci`; the exit codes are in `help`. */
export const ci: Command = {
  name: "ci",
  summary: "render the project's CI pipelines (GitHub, GitLab, Forgejo)",
  implemented: true,
  run: (args, io) =>
    guarded("ci", io, args, help, async () => {
      const a = parseCiArgs(args);
      if (a.fetchLedger) {
        const { fetchLedger } = await import("../chant/ledger-fetch.js");
        return fetchLedger(resolve(a.dir), io);
      }
      // The project, as every command reads it: chant.config.ts and a checked yodel.config.ts.
      const dir = (await loadProject(resolve(a.dir))).dir;
      if (a.replay) {
        const { replayLocally } = await import("../ci/replay.js");
        return replayLocally(dir, a.rest);
      }
      // Loaded here: the forge lexicons are for this command alone.
      const { render, PIPELINE_DIRS, PIPELINE_HEADER } = await import("../ci/render.js");
      let files;
      try {
        files = await render(dir);
      } catch (e) {
        throw new YodelError(e instanceof Error ? e.message : String(e));
      }
      const planned = files.map((f) => ({ rel: f.path, file: planFile(join(dir, f.path), f.content) }));
      const stale = planned.filter((p) => p.file.status !== "unchanged").map((p) => p.rel);
      // A pipeline file yodel ci wrote before and renders no more (#348): removed, or under --check reported.
      const left = staleGeneratedFiles({
        root: dir,
        dirs: PIPELINE_DIRS,
        files: [".gitlab-ci.yml"],
        match: /\.ya?ml$/,
        header: PIPELINE_HEADER,
        rendered: files.map((f) => f.path),
      });
      if (!a.check) {
        const removals = left.flatMap((p) => planRemoval(join(dir, p)) ?? []);
        writePlannedFiles([...planned.map((p) => p.file), ...removals]);
        for (const p of stale) io.out(`wrote ${p}\n`);
        for (const p of left) io.out(`removed ${p}\n`);
      }
      if (a.check && (stale.length > 0 || left.length > 0)) {
        if (stale.length > 0) io.err(`stale, run yodel ci: ${stale.join(", ")}\n`);
        if (left.length > 0) io.err(`no longer rendered, run yodel ci to remove: ${left.join(", ")}\n`);
        return 1;
      }
      if (a.check) io.out(`${String(files.length)} CI files are up to date\n`);
      return 0;
    }),
};
