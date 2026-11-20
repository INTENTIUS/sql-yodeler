/**
 * The environments as stages of chant's pipeline (#384): `.chant/pipeline.ts`
 * from yodel.config.ts, with chant's helpers.
 *
 * `ci.promotion` turns it on. yodel maps its config onto the stage keys of
 * chant's vocabulary and hands them to chant's `pipelineFromConfig`, which
 * writes the declaration; `pipelineSource` writes the file's text and
 * `checkPipelineFile` is what `yodel ci --check` runs on it. Each stage's
 * one wave is the environment's wave as `waves` and the sql lexicon's
 * `sql-migrate` step have it today, so the gate, the approval mode, the
 * tenant runs and the steps around apply stay yodel's keys.
 *
 * The merge applies the first stage. Its op-waves spec, which yodel commits
 * as `yodel-waves.json` and every wave job reads at the base commit, is the
 * first stage's spec from the folded file (`stageWavesSpec`), under the op
 * name the ledger has held since the waves began, `yodel-apply`, so
 * approvals keep counting. The last wave cuts a release (`yodel chant release
 * cut`), and each later stage takes it through `yodel promote --to <env>`,
 * whose gate chant reads from the folded file at the default branch.
 *
 * Everything here maps config. The gates, the risk score, the soak, the
 * holds, the sets and the refusal of `onVerifyFail: "rollback"` on a
 * `sql-migrate` stage are chant's.
 */

import { CI_SOAK_CHECK_KINDS, type CiApprovalRule, type CiConfig, type CiStageConfig } from "../config/define.js";

/** The committed file chant folds. */
export const PIPELINE_TS = ".chant/pipeline.ts";

/** What the file's header names: the product, its config and the command that writes it again. */
export const PIPELINE_SOURCE_OPTIONS = { product: "yodel", config: "yodel.config.ts", command: "yodel ci" } as const;

/** Whether the project's environments are chant pipeline stages: `ci.promotion` is set. */
export const pipelineOn = (ci: Pick<CiConfig, "promotion"> | undefined): boolean => ci?.promotion !== undefined;

/** The stage keys yodel reads under `ci.environments.<env>`, in camelCase. */
export const STAGE_KEYS = [
  "hold",
  "freeze",
  "failureTolerance",
  "approvalRules",
  "risk",
  "soak",
  "canary",
  "onVerifyFail",
  "after",
  "queue",
  "urgent",
  "pauseAfterRollback",
  "publish",
  "reads",
  "config",
  "secrets",
  "imports",
] as const;

/** `value` without the keys `keys`. */
const omit = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> => Object.fromEntries(Object.entries(value).filter(([k]) => !(keys as readonly PropertyKey[]).includes(k))) as Omit<T, K>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What is wrong with the pipeline keys of `ci`, as yodel reads them, or
 * undefined. `waves` is the waves' environments in order. The values are
 * chant's to check when `yodel ci` writes the file; here are the rules that
 * are yodel's: the promotion order is the waves' order, a stage is one of
 * them, a key is a stage key, and a soak check is of a kind a SQL project
 * has a reader for.
 */
export function pipelineConfigProblem(ci: Record<string, unknown>, waves: readonly string[] | undefined, where: string): string | undefined {
  const promotion = ci.promotion;
  const stageKeys = ["environments", "approvalRules", "risk", "configSets", "release", "recheck"].filter((k) => ci[k] !== undefined);
  if (promotion === undefined) {
    // Without a pipeline, the sets reach the wave jobs and the risk score the plan note; the rest are stage keys.
    const only = stageKeys.filter((k) => k !== "risk" && k !== "configSets" && k !== "environments");
    if (only.length > 0) return `${where}.${String(only[0])}: a pipeline key, read with ci.promotion; set ci.promotion to the environments in order`;
    const envs = ci.environments;
    if (envs === undefined) return undefined;
    if (!isRecord(envs)) return `${where}.environments: a map of stage settings, keyed by environment`;
    for (const [env, stage] of Object.entries(envs)) {
      const at = `${where}.environments.${env}`;
      if (waves && !waves.includes(env)) return `${at}: ${env} has no wave (waves: ${waves.join(", ")})`;
      const problem = stageProblem(stage, at);
      if (problem) return problem;
      const staged = Object.keys(stage as object).filter((k) => !["config", "secrets", "imports", "risk"].includes(k));
      if (staged.length > 0) return `${at}.${String(staged[0])}: a stage key, read with ci.promotion; set ci.promotion to the environments in order`;
    }
    return undefined;
  }
  if (!Array.isArray(promotion) || promotion.length === 0 || !promotion.every((e) => typeof e === "string" && e !== "")) return `${where}.promotion: the environments in promotion order, a list of names`;
  if (waves && (promotion.length !== waves.length || promotion.some((e, i) => e !== waves[i]))) {
    return `${where}.promotion: ${promotion.join(", ")}; the waves apply ${waves.join(", ")}, and the promotion order is the waves' order`;
  }
  const envs = ci.environments;
  if (envs !== undefined) {
    if (!isRecord(envs)) return `${where}.environments: a map of stage settings, keyed by environment`;
    for (const [env, stage] of Object.entries(envs)) {
      const at = `${where}.environments.${env}`;
      if (!promotion.includes(env)) return `${at}: ${env} is not a stage (ci.promotion: ${promotion.join(", ")})`;
      const problem = stageProblem(stage, at);
      if (problem) return problem;
    }
  }
  for (const key of ["approvalRules"] as const) if (ci[key] !== undefined && !Array.isArray(ci[key])) return `${where}.${key}: a list of approval rules`;
  const release = ci.release;
  if (release !== undefined && !(isRecord(release) && Object.keys(release).every((k) => k === "cut" || k === "label") && (release.cut === undefined || typeof release.cut === "boolean") && (release.label === undefined || typeof release.label === "string"))) {
    return `${where}.release: { cut?: true or false, label?: a label, or "auto" }`;
  }
  const recheck = ci.recheck;
  if (recheck !== undefined && !(isRecord(recheck) && Object.keys(recheck).every((k) => k === "schedule") && typeof recheck.schedule === "string" && recheck.schedule.trim().split(/\s+/).length === 5)) {
    return `${where}.recheck: { schedule } with a five-field cron, such as { schedule: "*/15 * * * *" }`;
  }
  return undefined;
}

/** One stage's settings: the stage keys, and soak checks of the kinds a SQL project reads. */
function stageProblem(stage: unknown, at: string): string | undefined {
  if (!isRecord(stage)) return `${at}: a map of stage settings`;
  for (const k of Object.keys(stage)) if (!(STAGE_KEYS as readonly string[]).includes(k)) return `${at}.${k}: unknown stage setting (expected ${STAGE_KEYS.join(", ")})`;
  const soak = stage.soak;
  if (soak !== undefined) {
    if (!isRecord(soak) || typeof soak.duration !== "string") return `${at}.soak: { duration, checks?, overrides? }, such as { duration: "30m", checks: [...] }`;
    const lists = [soak.checks, ...(Array.isArray(soak.overrides) ? soak.overrides.map((o: unknown) => (isRecord(o) ? o.checks : undefined)) : [])];
    for (const list of lists) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) return `${at}.soak.checks: a list of checks`;
      for (const check of list) {
        const kind = isRecord(check) ? check.kind : undefined;
        if (!(CI_SOAK_CHECK_KINDS as readonly unknown[]).includes(kind)) {
          return `${at}.soak: a check of kind ${JSON.stringify(kind)}; a SQL stage soaks on ${CI_SOAK_CHECK_KINDS.join(", ")} checks${kind === "health" ? " (the sql lexicon has no lifecycle health reader)" : ""}`;
        }
      }
    }
  }
  const risk = stage.risk;
  if (risk !== undefined && !(isRecord(risk) && Object.keys(risk).every((k) => k === "approveAbove" || k === "approvalRules"))) return `${at}.risk: { approveAbove?, approvalRules? }`;
  return undefined;
}

/** A wave of a stage, as `waves` and the sql lexicon's step have it: the forge-free part of yodel's waves spec. */
export interface StageWave {
  name: string;
  runs: Array<{ target: string; op: string }>;
  gate: string;
  shares?: number;
  approval?: string;
  hooks?: unknown;
}

/** What {@link pipelineDeclaration} reads. */
export interface PipelineInput {
  /** The pipeline's name, the op its stage gates are recorded under. */
  name: string;
  ci: CiConfig;
  /** The waves spec under yodel's words, without a forge's job settings: its waves become the stages' waves, the rest the pipeline's `defaults`. */
  spec: { name: string; waves: StageWave[] } & Record<string, unknown>;
  /** The command the release cut runs as, in place of `chant`. */
  bin: string[];
}

/** A rule as chant's `approval_rules` takes it, from yodel's camelCase. */
type RuleConfig = Record<string, unknown>;

const ruleOf = (r: CiApprovalRule): RuleConfig => ("all" in r ? { ...r, all: r.all.map(ruleOf) } : "any" in r ? { ...r, any: r.any.map(ruleOf) } : { ...r });

/** The quorum rules a stage's `risk.approvalRules` adds over its score, as chant's `holds.risk.quorum` takes them. */
function riskQuorum(rules: NonNullable<CiStageConfig["risk"]>["approvalRules"]): Array<Record<string, unknown>> | undefined {
  if (!rules || rules.length === 0) return undefined;
  return rules.map((r) => ({ ...(r.name !== undefined ? { name: r.name } : {}), count: r.count, ...(r.roles ? { roles: [...r.roles] } : {}), ...(r.notAuthor ? { notAuthor: true } : {}), ...(r.proven ? { proven: true } : {}) }));
}

/** A stage's `holds.risk`: its own `risk`, else `ci.risk.approveAbove` for every stage. */
export function stageRisk(ci: CiConfig, env: string): { approveAbove?: number; quorum?: Array<Record<string, unknown>> } | undefined {
  const own = ci.environments?.[env]?.risk;
  const approveAbove = own?.approveAbove ?? ci.risk?.approveAbove;
  const quorum = riskQuorum(own?.approvalRules);
  if (approveAbove === undefined && quorum === undefined) return undefined;
  return { ...(approveAbove !== undefined ? { approveAbove } : {}), ...(quorum ? { quorum } : {}) };
}

/** A stage's `risk` as chant's `pipelineFromConfig` reads it: its own keys, with `ci.risk.approveAbove` where the stage sets no threshold. */
export function stageRiskConfig(ci: CiConfig, env: string): { approveAbove?: number; approvalRules?: Array<Record<string, unknown>> } | undefined {
  const own = ci.environments?.[env]?.risk;
  const approveAbove = own?.approveAbove ?? ci.risk?.approveAbove;
  const rules = own?.approvalRules && own.approvalRules.length > 0 ? own.approvalRules.map(ruleOf) : undefined;
  if (approveAbove === undefined && rules === undefined) return undefined;
  return { ...(approveAbove !== undefined ? { approveAbove } : {}), ...(rules ? { approvalRules: rules } : {}) };
}

/** The pipeline's declaration from yodel.config.ts, through chant's `pipelineFromConfig`. Throws what chant refuses. */
export async function pipelineDeclaration(input: PipelineInput): Promise<import("@intentius/chant/pipeline").PipelineDeclaration> {
  const { pipelineFromConfig, verifyRollbackProblems } = await import("@intentius/chant/pipeline");
  const { ci } = input;
  const promotion = ci.promotion ?? [];
  const { waves } = input.spec;
  const defaults = omit(input.spec, ["name", "waves"]);
  const byEnv = Object.fromEntries(promotion.map((env) => [env, waves.filter((w) => w.name === env)]));
  const environments = Object.fromEntries(
    promotion.map((env) => {
      const stage = ci.environments?.[env] ?? {};
      const { approvalRules } = stage;
      const keys = omit(stage, ["risk", "approvalRules", "config", "secrets", "imports"]);
      // The risk keys (chant's `environments.<name>.risk`): the stage's own, else `ci.risk.approveAbove`; chant puts them on the gate's `holds.risk`.
      const risk = stageRiskConfig(ci, env);
      return [env, { ...keys, ...(approvalRules ? { approvalRules: approvalRules.map(ruleOf) } : {}), ...(risk ? { risk } : {}) }];
    }),
  );
  const declaration = pipelineFromConfig({
    name: input.name,
    promotion,
    environments: environments as never,
    ...(ci.approvalRules ? { approvalRules: ci.approvalRules.map(ruleOf) as never } : {}),
    waves: byEnv as never,
    defaults,
    release: { ...(ci.release?.cut !== undefined ? { cut: ci.release.cut } : {}), ...(ci.release?.label !== undefined ? { label: ci.release.label } : {}), bin: [...input.bin] },
    ...(ci.recheck ? { recheck: { schedule: ci.recheck.schedule } } : {}),
  });
  // chant refuses onVerifyFail: "rollback" on a stage that applies a sql-migrate step: a migration that ran stays run.
  const step = (defaults as { step?: { kind?: string } }).step;
  const refused = verifyRollbackProblems({ spec: declaration, steps: step?.kind ? [{ where: "defaults.step", kind: step.kind }] : [], capability: () => undefined });
  if (refused.length > 0) throw new Error(`yodel.config.ts: ci.environments: ${refused.join("; ")}`);
  return declaration;
}

/** The text of `.chant/pipeline.ts` for `declaration`, chant's `pipelineSource`. */
export async function pipelineText(declaration: import("@intentius/chant/pipeline").PipelineDeclaration): Promise<string> {
  const { pipelineSource } = await import("@intentius/chant/pipeline");
  return pipelineSource(declaration, PIPELINE_SOURCE_OPTIONS);
}

/**
 * The first stage's op-waves spec from the folded text: what the merge
 * applies. It keeps the op name the ledger holds the waves under, `name`.
 * Throws when the text does not fold.
 */
export async function firstStageSpec(text: string, name: string): Promise<Record<string, unknown> & { name: string; waves: StageWave[] }> {
  const { foldPipelineSource, pipelineFindingLine, stageWavesSpec } = await import("@intentius/chant/pipeline");
  const folded = foldPipelineSource(text, PIPELINE_TS);
  if ("finding" in folded) throw new Error(pipelineFindingLine(PIPELINE_TS, folded.finding));
  const first = folded.spec.stages[0];
  if (!first) throw new Error(`${PIPELINE_TS}: the pipeline has no stage`);
  const spec = omit(stageWavesSpec(folded.spec, first.name) as unknown as Record<string, unknown> & { waves: StageWave[] }, ["labels"]) as Record<string, unknown> & { waves: StageWave[] };
  return { ...spec, name, waves: spec.waves };
}

/** The stages after the first: the ones the promote jobs reach. */
export const laterStages = (ci: CiConfig): string[] => (ci.promotion ?? []).slice(1);

/**
 * chant's environment sets from `ci.environments.<env>` and `ci.configSets`,
 * or undefined when no stage names a set. Every wave environment gets a
 * set, an empty one when it names none, since chant refuses an environment
 * the sets leave out.
 */
export function environmentSetsOf(ci: CiConfig | undefined, envs: readonly string[]): import("@intentius/chant/components").EnvironmentSets | undefined {
  const named = Object.entries(ci?.environments ?? {}).filter(([, s]) => s.config !== undefined || s.secrets !== undefined || s.imports !== undefined);
  if (named.length === 0 && ci?.configSets === undefined) return undefined;
  const set = (s: CiStageConfig | undefined) => ({
    ...(s?.imports ? { imports: [...s.imports] } : {}),
    ...(s?.config ? { config: { ...s.config } } : {}),
    ...(s?.secrets ? { secrets: structuredClone(s.secrets) } : {}),
  });
  return {
    environments: Object.fromEntries(envs.map((env) => [env, set(ci?.environments?.[env])])),
    ...(ci?.configSets ? { configSets: structuredClone(ci.configSets) } : {}),
  };
}
