/**
 * yodel's words for chant's product pipeline (#287, chant#4550): the names a
 * pull request, a job log and a chat message show people, filled into
 * chant's own sentences. terragucci and plywood pass theirs the same way.
 *
 * The prefix is `yodel` (#285 ruling B): statuses read `yodel/plan` and
 * `yodel/apply`. A member is an environment. yodel applies on merge only
 * (#285 ruling E), so nothing applies before a merge and no `/yodel`
 * comment starts an apply. The comment commands are `/yodel new` (#312)
 * and `/yodel rebase` (#313), chant's commit job: each writes migrations
 * and pushes them to the pull request's branch, and applies nothing.
 *
 * The op and the wave gates keep the names sql-yodeler has recorded on
 * `chant/lifecycle` since the waves began (`yodel-apply`,
 * `yodel-apply-wave-<k>`, ../waves/record.ts), so approvals already on the
 * ledger keep counting. Approvals bind to each wave's own plan digest
 * (`per-wave`), as #285 has them: waves per environment behind approvals
 * bound to the plan digest.
 *
 * The words reach chant through the yodel bin (chant#4550 ruling C): `yodel
 * chant <args>` runs chant in this process with them (../commands/chant.ts),
 * and the jobs chant generates for yodel run that line in place of `chant`.
 *
 * {@link chantProduct} imports `@intentius/chant/ci-product` on first use,
 * so a command that renders no pipeline does not load it. The words
 * themselves are plain data and need no import of chant.
 */

import { WAVES_PIPELINE } from "./waves/record.js";

/** The stages chant names (chant's `CiProductStage`). */
export type YodelStage = "plan" | "apply" | "record" | "check" | "drift" | "lock" | "approval" | "control";

/** The shape of chant's `CiProductWordsInput`, for the slots yodel fills. Kept here so this module typechecks against a chant that lacks the subpath. */
export interface YodelWords {
  product: string;
  stages: Record<YodelStage, string>;
  verbs: { plan: [string, string]; apply: [string, string] };
  noun: [string, string];
  commands: Record<string, "plan" | "apply" | "lock" | "unlock" | "agent" | "commit">;
  approve: string;
  override: string;
  op: string;
  gateName: string;
  approval: "per-wave" | "pull-request";
  bin: string;
  /** What chant's notify sends under the words (chant's notify-product): the event's `source` and the webhook's header prefix. */
  notify: { source: string; headers: string };
}

/** The command the generated jobs run in place of `chant`: the yodel bin's pass-through to chant. */
export const YODEL_CHANT_BIN = "yodel chant";

/** yodel's words, checked by chant's `assertProductWords` (test/ci-words.test.ts). */
export const YODEL_WORDS: YodelWords = {
  product: "yodel",
  stages: { plan: "plan", apply: "apply", record: "record", check: "check", drift: "drift", lock: "lock", approval: "approval", control: "control" },
  verbs: { plan: ["plan", "planned"], apply: ["apply", "applied"] },
  noun: ["environment", "environments"],
  // Merge only (#285 ruling E): no command applies before merge. /yodel new and /yodel rebase are chant's commit job (#312, #313).
  commands: { new: "commit", rebase: "commit" },
  // The environment or tenant is the wave's run target (chant#4574).
  approve: "yodel approve {target} --plan {digest} {sign}",
  override: "yodel override {target} --rule {rule} --reason <text>",
  op: WAVES_PIPELINE,
  gateName: `${WAVES_PIPELINE}-wave-{k}`,
  approval: "per-wave",
  bin: YODEL_CHANT_BIN,
  // Webhook events (#61, #319) say sql-yodeler and are signed under x-yodel, as before chant had the slots.
  notify: { source: "sql-yodeler", headers: "x-yodel" },
};

/**
 * The pull request pipeline's env for chant's product plan (chant issue
 * 4799): each environment is a target of it, so its note's marker is
 * `<!-- chant-pr:yodel-pr:<env> -->` and its status `yodel/plan/<env>`.
 * `yodel plan --pr-note` writes it into the hand-off, which chant's note job
 * checks against its own.
 */
export const YODEL_PR_ENV = "yodel-pr";

/** The name of yodel's own line in a plan note, `<!-- yodel:plan env=<env> -->` (chant's `productMarker`). */
export const YODEL_NOTE_MARKER = "yodel:plan";

/** The words without their comment commands, for a part of chant's product pipeline that renders none of their jobs (the waves). */
export const WAVE_WORDS: YodelWords = { ...YODEL_WORDS, commands: {} };

/** One op-wave job of chant's product pipeline: its name and its argv, with yodel's bin in place of `chant`. */
export interface ProductWaveJob {
  jobName: string;
  command: string[];
}

/** What `productPipelineJobs` gives back that yodel ci reads (#289). */
export interface ProductPipeline {
  /** The words, every slot filled. */
  words: unknown;
  /** The apply on merge: the spec under yodel's op and gate names, its file, and a job per wave. */
  waves?: { spec: unknown; specFile: string; jobs: ProductWaveJob[] };
}

/** What yodel uses of `@intentius/chant/ci-product`. */
export interface ChantProduct {
  assertProductWords: (words: YodelWords) => unknown;
  runChantInProcess: (argv: string[], words: YodelWords) => Promise<number>;
  approveLine: (words: unknown, input: { op: string; gate: string; digest: string; sign?: boolean; target?: string }) => string;
  productPipelineJobs: (forge: "github" | "gitlab" | "forgejo", env: string, options: { words: YodelWords; waves?: unknown; wavesSpecFile?: string }) => ProductPipeline;
}

let product: Promise<ChantProduct> | undefined;

/** chant's product entry, once (chant#4550; every chant yodel installs has it). */
export function chantProduct(): Promise<ChantProduct> {
  product ??= import("@intentius/chant/ci-product").then((m) => m as unknown as ChantProduct);
  return product;
}
