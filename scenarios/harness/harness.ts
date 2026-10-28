/**
 * chant's e2e harness (INTENTIUS/chant#4587), as sql-yodeler reaches it.
 *
 * The harness is `@intentius/chant/e2e-harness`, in chant from 0.124.56, the
 * floor sql-yodeler installs. The types below are the parts of the harness's
 * contracts the scenarios read, and `loadHarness` gives the module as that
 * shape. They follow e2e-scenario/v1 and pr-report/v1 as chant's schemas give
 * them.
 */

/** What a scenario step does (e2e-scenario/v1 `do`). */
export type StepKind = "open" | "open-concurrent" | "plan" | "approve" | "merge" | "apply" | "out-of-band" | "kill-job";

/** One outcome a step must show: one key each. */
export type Outcome =
  | { report: { status?: string; components?: Record<string, string>; only?: boolean } }
  | { ledger: { op: string; status?: "ok" | "fail" | "gated" | "waiting"; count?: number } }
  | { comment: string }
  | { issue: { title: string; open?: boolean } }
  | { exit: number };

interface StepBase {
  id: string;
  label?: string;
  expect?: Outcome[];
}

export type Step =
  | (StepBase & { do: "open" | "open-concurrent"; branch: string; overlay: string; title: string; body?: string })
  | (StepBase & { do: "plan" | "approve" | "merge"; pull: string })
  | (StepBase & { do: "apply"; merge: string })
  | (StepBase & { do: "out-of-band"; command: string[] })
  | (StepBase & { do: "kill-job"; match?: string });

export const SCENARIO_SCHEMA = "https://intentius.io/chant/schemas/e2e-harness/e2e-scenario/v1/e2e-scenario.schema.json";

/** An e2e-scenario/v1 file. */
export interface Scenario {
  $schema: typeof SCENARIO_SCHEMA;
  contract: 1;
  id: string;
  product: string;
  claim: string;
  title?: string;
  tree: { base: string; overlays?: string };
  env?: string;
  reportUrl: string;
  limits?: Partial<Record<StepKind, number>>;
  steps: Step[];
  break: { env: { BREAK: "1" } & Record<string, string>; overlay?: string; note?: string };
}

/** pr-report/v1, the fields the harness's driver reads (chant reports.ts PrReportView). */
export interface ReportView {
  stage: "plan" | "apply";
  pr: number | null;
  head: string;
  op: string;
  gate: string;
  digest: string;
  status: string;
  refusal?: string;
  message?: string;
  approval?: { status?: string };
  selection: { waves: string[][] };
  members: Array<{ member: string; component: string; status: string; error?: string }>;
}

/** An op run record (chant op/runtime OpRunRecord), the fields the scenarios read, and the wave field yodel's apply jobs add (chant#4551). */
export interface RunRecordView {
  id: string;
  op: string;
  env: string;
  started: string;
  ended: string;
  status: "ok" | "fail" | "gated" | "waiting";
  gitSha?: string;
  wave?: { number: number; name: string; applied?: string[]; failed?: string[]; moved?: string[] };
}

/** One finding of a scenario lint: where, as a JSON pointer, and why. */
export interface Finding {
  at: string;
  message: string;
}

/**
 * What the harness module gives, as far as the scenarios use it. Each
 * member is checked to be there before the module counts.
 */
export interface Harness {
  E2E_HARNESS_FLOOR: string;
  lintScenario(data: unknown): Finding[];
  runClaim(scenario: Scenario, ports: unknown, opts: { approver: string; pollMs?: number }): Promise<{
    plain: { outcome: string; reason?: string };
    break: { outcome: string; reason?: string };
    verdicts: { plain: "pass" | "fail"; break: "caught" | "missed" | "stalled" };
  }>;
  ForgejoForge: new (o: unknown) => unknown;
  forgejoApi(url: string, token: string, method: string, path: string, body?: unknown, opts?: { missingOk?: boolean }): Promise<unknown>;
  SafeRun: new (o: { scratch: string; extra?: Record<string, string>; logFile?: string; scan?: string[] }) => {
    readonly env: Record<string, string>;
    log(line: string): void;
    run(command: string[], extra?: Record<string, string>): Promise<number>;
    outOfBand(): { run(command: string[]): Promise<number> };
    scan(extraDirs?: string[]): { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] };
  };
  claimRow(i: unknown): unknown;
  recordClaimRow(i: unknown): Promise<unknown>;
  claimRowsOf(records: readonly unknown[]): unknown[];
  renderClaims(product: string, rows: readonly unknown[]): unknown;
  harnessUrls(s: { portVars: Record<string, string> }, env?: Record<string, string | undefined>): Record<"floci" | "forgejo" | "clickhouse" | "postgres", string>;
  harnessStack(o: { project: string }): { portVars: Record<string, string> };
  HARNESS_HOSTS: Record<"floci" | "forgejo" | "clickhouse" | "postgres", string>;
  FLOCI_DIGEST: string;
  CLAIM_OP: string;
}

/** chant's harness, `@intentius/chant/e2e-harness` (chant 0.124.56 and later). */
export function loadHarness(): Promise<Harness> {
  loaded ??= import("@intentius/chant/e2e-harness").then((m) => m as unknown as Harness);
  return loaded;
}

let loaded: Promise<Harness> | undefined;

/**
 * Every reason `s` is not a scenario sql-yodeler's runner can drive, by the
 * rules chant's lintScenario holds (a claim id, a BREAK arm with BREAK=1,
 * steps that name earlier steps, something expected) plus sql-yodeler's
 * own: the product is sql-yodeler, and the claim is one of `claims`. A
 * chant with the harness lints the file again with its own schema.
 */
export function lintLocal(s: Scenario, claims: readonly string[]): Finding[] {
  const out: Finding[] = [];
  // A file is read as a Scenario before it is checked, so these may hold anything.
  const loose = s as unknown as { $schema?: unknown; contract?: unknown; break?: { env?: Record<string, unknown> } };
  if (loose.$schema !== SCENARIO_SCHEMA || loose.contract !== 1) out.push({ at: "/$schema", message: "not an e2e-scenario/v1 file" });
  if (s.product !== "sql-yodeler") out.push({ at: "/product", message: `the product is ${s.product}, not sql-yodeler` });
  if (!s.claim) out.push({ at: "/claim", message: "the scenario has no claim id, so its run would record a row for nothing" });
  else if (!claims.includes(s.claim)) out.push({ at: "/claim", message: `claim ${s.claim} is not in scenarios/claims/index.ts` });
  if (loose.break?.env?.BREAK !== "1") out.push({ at: "/break/env/BREAK", message: 'the BREAK arm must set BREAK to "1"' });
  if (!/^s3:\/\/[^/]+\/.+/.test(s.reportUrl)) out.push({ at: "/reportUrl", message: "reportUrl is not s3://<bucket>/<prefix>" });
  const seen = new Map<string, Step>();
  let expectations = 0;
  s.steps.forEach((step, i) => {
    const at = `/steps/${String(i)}`;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(step.id)) out.push({ at: `${at}/id`, message: `step id ${step.id} is not a name` });
    if (seen.has(step.id)) out.push({ at: `${at}/id`, message: `step id ${step.id} is used twice` });
    const opened = (id: string) => {
      const o = seen.get(id);
      return o?.do === "open" || o?.do === "open-concurrent";
    };
    if ((step.do === "plan" || step.do === "approve" || step.do === "merge") && !opened(step.pull)) {
      out.push({ at: `${at}/pull`, message: `${step.do} names ${step.pull}, which is not an earlier open step` });
    }
    if (step.do === "apply" && seen.get(step.merge)?.do !== "merge") out.push({ at: `${at}/merge`, message: `apply names ${step.merge}, which is not an earlier merge step` });
    if (step.do === "open-concurrent") {
      const prev = s.steps[i - 1];
      if (prev?.do !== "open" && prev?.do !== "open-concurrent") out.push({ at: `${at}/do`, message: "open-concurrent opens beside the step before it, which must be an open" });
    }
    for (const [j, e] of (step.expect ?? []).entries()) {
      expectations++;
      const keys = Object.keys(e);
      if (keys.length !== 1) out.push({ at: `${at}/expect/${String(j)}`, message: "an outcome has exactly one key" });
      if ("report" in e && step.do !== "plan" && step.do !== "apply") out.push({ at: `${at}/expect/${String(j)}`, message: `a report outcome belongs on a plan or apply step, not ${step.do}` });
      if ("exit" in e && step.do !== "out-of-band") out.push({ at: `${at}/expect/${String(j)}`, message: "an exit outcome belongs on an out-of-band step" });
      if ("comment" in e && !("pull" in step) && step.do !== "open" && step.do !== "open-concurrent") out.push({ at: `${at}/expect/${String(j)}`, message: "a comment outcome belongs on a step with a pull request" });
    }
    seen.set(step.id, step);
  });
  if (expectations === 0) out.push({ at: "/steps", message: "no step expects anything, so the plain run would pass and the BREAK run could never be caught" });
  return out;
}
