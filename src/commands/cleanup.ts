import { parseArgs } from "node:util";
import type { Command, Io } from "../command.js";
import { guarded } from "../env-args.js";
import { loadProject, resolveEnvironment, YodelError, type Environment, type Project } from "../project.js";
import { appliedBy, withLock } from "../history/index.js";
import { closeVersioned, findMigrateOp, gitLedger, openVersioned, verifyApproval, type VersionedEnv } from "../versioned/index.js";
import { approveCommand, migrationsApprovalAtBase, portFor, signFlag } from "../approval-mode/index.js";
import { runnable } from "../chant/runnable.js";
import { cleanupDigest, cleanupGate, describeRetained, dropRetained, findRetained, retainedServer, type Retained } from "../cleanup/index.js";
import { EXIT_MOVED, EXIT_WAITING } from "../exit.js";
import { askGatedRequest, gatedRequests, spendAndAct, type GatedRequestApi } from "../chant/gated-request.js";

/** The kind of gated request (chant#4551) a drop is asked for under. */
export const CLEANUP_REQUEST = "sql-cleanup";

const usage = "usage: yodel cleanup <env> [--list] [--op <name>] [--json] [--dir <project>]";

const help = `${usage}

Lists what steps kept in <env> on purpose, and drops what is past its
retention date, behind the environment's approval:

- a ClickHouse rebuild's old table, <table>__chant_old, kept after the swap
  (7 days, or the step's retain);
- a Postgres rename's or type change's old column, kept after the switch
  when the step set retain (yodel new --retain), with the trigger and
  function that keep a renamed column written.

Each one's date is in its own comment, and the server's clock decides
whether it has passed. Nothing is dropped before its date.

When something is due, the drop is a plan like an apply's: its digest
covers each due object (a table by its UUID, a column by its table and
attribute number) and its date. Without an approval for that digest on
the migrations Op's cleanup gate (its gate's name with -cleanup, e.g.
approve-migrate-prod-cleanup, apart from the apply's approvals), yodel
cleanup lists what it would drop, prints the digest and the command that
approves it, yodel approve <env> --plan <digest>, and drops nothing (exit
3). Approve it, run yodel cleanup <env> again, and it drops them under the
apply lock, after reading them again: if anything due changed, the digest
differs and the approval does not count. The environment's approval mode
counts as it does for yodel apply: under sealed (environments.<env>.approval,
read at the base commit), only an approval sealed with yodel approve --sign
by a key .chant/allowed_signers lists for its approver.

With a chant that has gated requests (chant#4551), the drop is asked for as
one, on the same gate: chant records the request (the environment and the
cleanup digest), prints the request's digest, and the approval binds that.
The requester's own approval does not count; someone else approves it. The
drop spends the approval, and chant records how it ended, so chant ledger
gates lists the request, its approval, the apply and its end.

Options:
  --list           list only; never drop, even with an approval
  --op <name>      the migrations Op, when more than one applies <env>
  --json           print the list (and what was dropped) as JSON
  -C, --dir <dir>  the project directory (default: the working directory)

Exit codes:
  0  nothing is due (and nothing was dropped), the due objects were dropped,
     or --list
  3  something is due and waits for an approval; nothing was dropped
  5  another apply holds the lock
  1  an error: a bad config, an unknown environment, a server it cannot read
`;

interface CleanupArgs {
  env: string;
  list: boolean;
  op: string | undefined;
  json: boolean;
  dir: string;
}

function parseCleanupArgs(args: string[]): CleanupArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { list: { type: "boolean" }, op: { type: "string" }, json: { type: "boolean" }, dir: { type: "string", short: "C" } } });
  } catch (e) {
    throw new YodelError(`${e instanceof Error ? e.message : String(e)}\n${usage}`);
  }
  const [env, ...rest] = parsed.positionals;
  if (env === undefined || rest.length > 0) throw new YodelError(usage);
  const v = parsed.values;
  return { env, list: v.list === true, op: typeof v.op === "string" ? v.op : undefined, json: v.json === true, dir: typeof v.dir === "string" ? v.dir : process.cwd() };
}

/** `yodel cleanup --json` (schemas/cleanup.schema.json). */
export function cleanupJson(r: { environment: string; now: string; retained: readonly Retained[]; planDigest?: string | undefined; approve?: string | undefined; chantApprove?: string | undefined; dropped: readonly string[] }): Record<string, unknown> {
  return {
    environment: r.environment,
    now: r.now,
    retained: r.retained.map((x) => ({ kind: x.kind, name: x.name, of: x.of, ...(x.retainUntil ? { retainUntil: x.retainUntil } : {}), due: x.due, identity: x.identity, ...(x.trigger ? { trigger: x.trigger } : {}) })),
    due: r.retained.filter((x) => x.due).length,
    ...(r.planDigest ? { planDigest: r.planDigest } : {}),
    ...(r.approve ? { approve: r.approve } : {}),
    ...(r.chantApprove ? { chantApprove: r.chantApprove } : {}),
    dropped: r.dropped,
  };
}

/** `yodel cleanup <env>`; the exit codes are in `help`. */
export const cleanup: Command = {
  name: "cleanup",
  summary: "drop the old tables and columns steps kept, once past their date",
  implemented: true,
  run: (args, io) =>
    guarded("cleanup", io, args, help, async () => {
      const a = parseCleanupArgs(args);
      const project = await loadProject(a.dir);
      const env = resolveEnvironment(project, a.env);
      const venv = await openVersioned(project, env);
      try {
        return await cleanupWith(project, env, venv, a, io);
      } finally {
        await closeVersioned(venv);
      }
    }),
};

async function cleanupWith(project: Project, env: Environment, venv: VersionedEnv, a: CleanupArgs, io: Io): Promise<number> {
  const server = retainedServer(venv);
  const { now, retained } = await findRetained(server);
  const dueCount = retained.filter((r) => r.due).length;
  const lines = [`Kept by steps in ${env.name} (server time ${now}):`];
  if (retained.length === 0) lines[0] = `Nothing kept by steps in ${env.name}: no old table or old column waits for its retention date.`;
  for (const r of retained) lines.push(`  ${describeRetained(r)}`);
  const report = (extra: { planDigest?: string; approve?: string; chantApprove?: string; dropped?: string[] }, tail: string[] = []) => {
    if (a.json) io.out(`${JSON.stringify(cleanupJson({ environment: env.name, now, retained, dropped: [], ...extra }), null, 2)}\n`);
    else io.out(`${[...lines, ...tail].join("\n")}\n`);
  };
  if (dueCount === 0 || a.list) {
    report({}, retained.length > 0 && dueCount === 0 ? ["", "Nothing is due: nothing dropped."] : []);
    return 0;
  }

  const digest = await cleanupDigest(env.name, retained);
  const migrate = await findMigrateOp(project, env, a.op);
  // Its own gate on the migrations Op, so an apply's approval is never confused with it.
  const op = { ...migrate, gate: cleanupGate(migrate.gate) };
  // The environment's approval mode, as an apply's (#48, #130): under sealed, only a sealed approval counts.
  const mode = await migrationsApprovalAtBase(project, env.name);
  if (mode.note && !a.json) io.err(`${mode.note}\n`);
  const ledger = await portFor(await gitLedger(project.dir), mode.mode, project.dir, mode.base);
  // chant's gated request (#292, chant#4551), when the installed chant has it.
  const gated = await gatedRequests();
  if (gated) return cleanupRequested(gated, { project, env, venv, a, io, server, retained, digest, dueCount, op, mode, ledger, report });
  const approve = approveCommand(env.name, digest, mode.mode);
  const chantApprove = `chant approve ${op.name} ${op.gate} --plan ${digest}${signFlag(mode.mode)}`;
  try {
    await verifyApproval(ledger, op, digest);
  } catch (e) {
    if (!(e instanceof YodelError) || (e.exitCode !== EXIT_WAITING && e.exitCode !== EXIT_MOVED)) throw e;
    // An approval of this digest the mode does not count (an unsigned one under sealed), and why.
    const uncounted = /\((the approval by .* does not count: .*)\)\. Nothing was applied\./s.exec(e.message)?.[1];
    report({ planDigest: digest, approve, chantApprove }, [
      "",
      `Plan digest: ${digest}`,
      ...(uncounted ? [`${uncounted[0]?.toUpperCase() ?? ""}${uncounted.slice(1)}.`] : []),
      `${String(dueCount)} due; nothing dropped without an approval${mode.mode === "sealed" ? " sealed by a signer (approval sealed)" : ""}. Approve it with:`,
      `  ${runnable(approve, project.dir)}`,
      `then run yodel cleanup ${env.name} again.`,
    ]);
    return EXIT_WAITING;
  }

  const lock = await venv.driver.acquireLock(appliedBy());
  if (lock.notice && !a.json) io.err(`lock: ${lock.notice}\n`);
  const dropped = await withLock(lock, venv.lockTtlMs, async () => {
    // Read again under the lock: the approval counts only for what is due now.
    const again = await findRetained(server);
    const now = await cleanupDigest(env.name, again.retained);
    const by = await verifyApproval(ledger, op, now);
    if (!a.json) io.err(`approval: ${op.name} / ${op.gate} for ${now}, by ${by.resolvedBy} at ${by.timestamp}${by.signer ? `, sealed by ${by.signer}` : ""}\n`);
    return dropRetained(server, again.retained, (l) => {
      if (!a.json) io.err(`${l}\n`);
    });
  });
  report({ planDigest: digest, dropped }, ["", `Dropped ${String(dropped.length)}: ${dropped.join(", ")}`]);
  return 0;
}

type Report = (extra: { planDigest?: string; approve?: string; chantApprove?: string; dropped?: string[] }, tail?: string[]) => void;

/**
 * The drop as chant's gated request (#292, chant#4551): the request, under
 * the migrations Op with its cleanup gate as the subject, binds the
 * environment and the cleanup digest, and chant digests it. A first run
 * records the pending fact and waits (exit 3); `yodel approve <env> --plan
 * <digest>` approves it, and the requester's own approval does not count.
 * Once approved, under the lock: what is due is read again and must still
 * be the cleanup digest the request names, the engine checks the approval
 * on chant's ledger itself (ruling A on #300), the approval is spent
 * (pushed before anything is dropped), and the finished line records what
 * was dropped.
 */
async function cleanupRequested(
  gated: GatedRequestApi,
  c: {
    project: Project;
    env: Environment;
    venv: VersionedEnv;
    a: CleanupArgs;
    io: Io;
    server: ReturnType<typeof retainedServer>;
    retained: readonly Retained[];
    digest: string;
    dueCount: number;
    op: { name: string; filePath: string; gate: string; quorum: boolean };
    mode: { mode: "ledger" | "sealed"; base?: string | undefined };
    ledger: Awaited<ReturnType<typeof portFor>>;
    report: Report;
  },
): Promise<number> {
  const { project, env, venv, a, io, server, digest, dueCount, op, mode, ledger, report } = c;
  const asked = await askGatedRequest(gated, {
    op: op.name,
    kind: CLEANUP_REQUEST,
    subject: op.gate,
    fields: { environment: env.name, plan: digest },
    description: `yodel cleanup ${env.name}: drop ${String(dueCount)} kept object${dueCount === 1 ? "" : "s"} past ${dueCount === 1 ? "its" : "their"} date (${digest})`,
    rules: { mode: mode.mode },
    base: mode.base,
    cwd: project.dir,
  });
  if (asked.status !== "approved") {
    const approve = approveCommand(env.name, asked.digest, mode.mode);
    const command = asked.status === "spent" ? undefined : asked.command;
    report({ planDigest: asked.digest, approve, ...(command ? { chantApprove: command } : {}) }, [
      "",
      `Request digest: ${asked.digest} (chant's gated request on ${op.name} / ${op.gate}, for cleanup digest ${digest})`,
      ...(asked.status === "refused" ? [`The approval by ${asked.by} does not count: ${asked.reason}.`] : []),
      ...(asked.status === "spent" ? [`That request was spent by an earlier drop; run yodel cleanup ${env.name} again to ask anew.`] : []),
      `${String(dueCount)} due; nothing dropped without an approval${mode.mode === "sealed" ? " sealed by a signer (approval sealed)" : ""}, by someone other than the requester. Approve it with:`,
      `  ${runnable(approve, project.dir)}`,
      `then run yodel cleanup ${env.name} again.`,
    ]);
    return EXIT_WAITING;
  }

  const lock = await venv.driver.acquireLock(appliedBy());
  if (lock.notice && !a.json) io.err(`lock: ${lock.notice}\n`);
  const dropped = await withLock(lock, venv.lockTtlMs, async () => {
    // Read again under the lock: the approval counts only for what is due now.
    const again = await findRetained(server);
    const now = await cleanupDigest(env.name, again.retained);
    if (now !== digest) {
      throw new YodelError(`refused: what is due in ${env.name} moved since the request was approved (approved ${digest}, now ${now}); nothing was dropped. Run yodel cleanup ${env.name} again.`, EXIT_MOVED);
    }
    // The engine's own check (ruling A on #300): chant's ledger approves the request's digest.
    const by = await verifyApproval(ledger, op, asked.digest);
    if (!a.json) io.err(`approval: ${op.name} / ${op.gate} for ${asked.digest}, by ${by.resolvedBy} at ${by.timestamp}${by.signer ? `, sealed by ${by.signer}` : ""}\n`);
    const { result } = await spendAndAct(gated, asked, { op: op.name, cwd: project.dir }, async () => {
      const names = await dropRetained(server, again.retained, (l) => {
        if (!a.json) io.err(`${l}\n`);
      });
      return { result: names, detail: { environment: env.name, cleanup: digest, dropped: names.length } };
    });
    return result;
  });
  report({ planDigest: asked.digest, dropped }, ["", `Dropped ${String(dropped.length)}: ${dropped.join(", ")}`]);
  return 0;
}
