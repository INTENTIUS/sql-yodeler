/**
 * yodel's words for chant's product pipeline (#287, chant#4550): the names a
 * pull request, a job log and a chat message show people, filled into
 * chant's own sentences. terragucci and plywood pass theirs the same way.
 *
 * The prefix is `yodel` (#285 ruling B): statuses read `yodel/plan` and
 * `yodel/apply`. A member is an environment. The words name no comment
 * command: yodel applies on merge only (#285 ruling E), so nothing applies
 * before a merge and no `/yodel` comment starts an apply.
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
 * `@intentius/chant/ci-product` is newer than the chant sql-yodeler's main
 * pins. {@link chantProduct} imports it lazily, with the specifier in a
 * variable, so a published chant without it leaves yodel as it was. The
 * words themselves are plain data and need no import of chant.
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
  commands: Record<string, "plan" | "apply" | "lock" | "unlock" | "agent">;
  approve: string;
  override: string;
  op: string;
  gateName: string;
  approval: "per-wave" | "pull-request";
  bin: string;
}

/** The command the generated jobs run in place of `chant`: the yodel bin's pass-through to chant. */
export const YODEL_CHANT_BIN = "yodel chant";

/** yodel's words, checked by chant's `assertProductWords` (test/ci-words.test.ts). */
export const YODEL_WORDS: YodelWords = {
  product: "yodel",
  stages: { plan: "plan", apply: "apply", record: "record", check: "check", drift: "drift", lock: "lock", approval: "approval", control: "control" },
  verbs: { plan: ["plan", "planned"], apply: ["apply", "applied"] },
  noun: ["environment", "environments"],
  // Merge only (#285 ruling E): no comment command, so no apply before merge.
  commands: {},
  // The environment or tenant is the wave's run target (chant#4574).
  approve: "yodel approve {target} --plan {digest} {sign}",
  override: "yodel override {target} --rule {rule} --reason <text>",
  op: WAVES_PIPELINE,
  gateName: `${WAVES_PIPELINE}-wave-{k}`,
  approval: "per-wave",
  bin: YODEL_CHANT_BIN,
};

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
  /** A shell line with the words' bin in place of `chant`. */
  productCommand: (words: unknown, line: string) => string;
}

let product: Promise<ChantProduct | undefined> | undefined;

/**
 * chant's product entry, once, or undefined when the installed chant has
 * none (a release before chant#4550). Its presence is
 * `productPipelineJobs`, `approveLine` and `assertProductWords` together,
 * as chant's ci-product.ts asks a product to check, plus
 * `runChantInProcess`, which the bin calls, and `productCommand`, which
 * yodel ci puts the bin into its own jobs' lines with (#289).
 */
export function chantProduct(): Promise<ChantProduct | undefined> {
  product ??= (async () => {
    const specifier = "@intentius/chant/ci-product";
    let m: Partial<ChantProduct> | undefined;
    try {
      m = (await import(specifier)) as Partial<ChantProduct>;
    } catch {
      return undefined;
    }
    const has = (k: keyof ChantProduct) => typeof m[k] === "function";
    const all: Array<keyof ChantProduct> = ["productPipelineJobs", "approveLine", "assertProductWords", "runChantInProcess", "productCommand"];
    return all.every(has) ? (m as ChantProduct) : undefined;
  })();
  return product;
}
