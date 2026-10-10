/**
 * Approval modes (#48): which approvals of a gate's plan digest count.
 *
 * - `ledger` (the default): any `chant approve` of the digest on
 *   `chant/lifecycle`. Anyone who can push to that branch can approve, in
 *   anyone's name.
 * - `pr-review` (a wave's only): also the review of the pull request that
 *   merged the commit being applied: an approving review of its head by a
 *   writer other than its author approves the digest that head planned,
 *   which the pull request's pipeline records (`chant run wave
 *   --record-plans`). chant judges it, in `chant run wave`, and writes the
 *   approval it makes of the review to the ledger.
 * - `sealed`: only an approval sealed with `chant approve --sign` (`yodel
 *   approve --sign`) by a key the signers file lists for its approver. The
 *   file is `.chant/allowed_signers` at the repository's root (or the path
 *   `.chant/trust.json` names), read at the base commit, so a key the change
 *   itself adds does not count for it.
 *
 * A wave's mode is `waves[].approval`, which yodel ci writes into the waves
 * spec, where chant reads it at the base commit with the gate policy. The
 * migrations Op's gate (yodel apply <env> outside the waves) takes
 * `environments.<env>.approval`, read from yodel.config.ts at the base
 * commit; without it, `sealed` when the environment's wave is sealed, else
 * `ledger`. yodel checks it itself where it checks an approval
 * (`--execute`, `--wave-apply`), so an unsealed approval chant's gate step
 * let through still applies nothing.
 */

import type { GateApprovalRule, GateLedgerPort } from "@intentius/chant/op/gate";
import type { ApprovalMode, EnvironmentApprovalMode, YodelConfig } from "../config/define.js";
import { loadYodelConfigAtBase } from "../config/base.js";
import { baseEnvironment } from "../tenants/target.js";

export type { ApprovalMode, EnvironmentApprovalMode };

/**
 * Set (to `1`) by `yodel ci` on the pull request job that records the plans
 * each head makes for a `pr-review` wave, `chant run wave --record-plans`:
 * `yodel apply <env> --wave-plan` then plans the wave as it will be after the
 * merge, once the environments it requires have applied what is pending.
 * `--wave-apply` never reads it.
 */
export const RECORD_PLANS_ENV = "YODEL_WAVE_RECORD_PLANS";

/** Where chant reads the signers when `.chant/trust.json` names no other path. */
export const SIGNERS_FILE = ".chant/allowed_signers";

/** `env`'s wave's mode in `config`; `ledger` when no wave names it or the wave sets none. */
export function waveApproval(config: YodelConfig | undefined, env: string): ApprovalMode {
  return config?.waves?.find((w) => w.env === baseEnvironment(env))?.approval ?? "ledger";
}

/** The migrations Op's mode for `env` in `config`: the environment's, else `sealed` when its wave is, else `ledger`. */
export function migrationsApproval(config: YodelConfig | undefined, env: string): EnvironmentApprovalMode {
  const own = config?.environments?.[baseEnvironment(env)]?.approval;
  if (own) return own;
  return waveApproval(config, env) === "sealed" ? "sealed" : "ledger";
}

/** The migrations Op's mode as the base commit has it. */
export interface ApprovalAtBase {
  mode: EnvironmentApprovalMode;
  /** The commit the signers file is read at, when the base could be read. */
  base?: string;
  /** Why the working tree's mode is not the one that applies, when they differ. */
  note?: string;
}

/**
 * `env`'s migrations Op mode from yodel.config.ts at the base commit, so a
 * change cannot loosen the mode that gates its own merge. A checkout with no
 * base to read (no git, a repository's first commit) takes the working
 * tree's, and a sealed one then has no signers file at base to verify
 * against, so nothing counts.
 */
export async function migrationsApprovalAtBase(project: { dir: string; yodel?: { config: YodelConfig } | undefined }, env: string, processEnv: NodeJS.ProcessEnv = process.env): Promise<ApprovalAtBase> {
  const tree = migrationsApproval(project.yodel?.config, env);
  let at;
  try {
    at = await loadYodelConfigAtBase(project.dir, processEnv);
  } catch (e) {
    const why = e instanceof Error ? (e.message.split("\n")[0] ?? "") : String(e);
    return { mode: tree, ...(tree !== "ledger" ? { note: `approval: yodel.config.ts could not be read at the base commit (${why}), so ${env}'s approval mode is the working tree's, ${tree}` } : {}) };
  }
  const mode = migrationsApproval(at.config, env);
  return { mode, base: at.sha, ...(mode !== tree ? { note: `approval: ${env}'s approvals count as ${mode}, as yodel.config.ts has it at the base commit ${at.sha.slice(0, 12)}, not ${tree} as this change has it` } : {}) };
}

/**
 * `port`, with every gate it is asked for also sealed: an approval counts
 * only when its seal verifies, for the approver it names, against the
 * signers file at `base` (and the workspace's own rule, when it has one,
 * accepts it too). No signers file at base, nothing counts.
 */
export async function sealedPort(port: GateLedgerPort, cwd: string, base: string | undefined): Promise<GateLedgerPort> {
  const review = await import("@intentius/chant/op/gate-review");
  const sealed = (gate: string): GateApprovalRule =>
    base === undefined
      ? { requirement: { gate, class: null }, refuses: () => `the gate is sealed, and there is no base commit to read the signers file (${SIGNERS_FILE}) at` }
      : review.sealedApprovalRule(gate, review.trustPolicyAt(cwd, base));
  return {
    ...port,
    read: (op) => port.read(op),
    async approvalRule(gate: string): Promise<GateApprovalRule | null> {
      const own = (await port.approvalRule?.(gate)) ?? null;
      return review.bothRules(own, sealed(gate));
    },
  };
}

/** `port` as `mode` judges approvals: sealed at `base`, or as it is. */
export async function portFor(port: GateLedgerPort, mode: ApprovalMode, cwd: string, base: string | undefined): Promise<GateLedgerPort> {
  return mode === "sealed" ? sealedPort(port, cwd, base) : port;
}

/** What a printed approve command needs for `mode`: `--sign` under sealed. */
export const signFlag = (mode: ApprovalMode): string => (mode === "sealed" ? " --sign" : "");

/** One sentence on which approvals count under `mode`, for the plan and the pull request comment. */
export function describeApprovalMode(mode: ApprovalMode, code: (s: string) => string = (s) => s): string {
  if (mode === "sealed") return `Approvals count only sealed (approval ${code("sealed")}): ${code("chant approve --sign")} or ${code("yodel approve --sign")}, with a key ${code(SIGNERS_FILE)} at the base commit lists for the approver.`;
  if (mode === "pr-review") return `Approval ${code("pr-review")}: an approving review of this pull request's head, by a writer other than its author, approves the plan that head records; ${code("chant approve")} of the digest counts too.`;
  return `Approval ${code("ledger")}: any ${code("chant approve")} of the digest counts.`;
}
