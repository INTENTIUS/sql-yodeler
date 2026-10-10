/**
 * `yodel mcp`'s tools. Each runs read-only `yodel` commands in this process
 * with `--json` and returns what they print, in one envelope
 * (schemas/mcp.schema.json). There is no tool that applies, approves,
 * repairs, rebases, writes a migration or overrides a policy, and
 * {@link assertReadOnly} refuses a tool list that has one, so the server does
 * not start with it.
 */

import type { Command, Io } from "../command.js";
import { DOCS_URL } from "../cli.js";
import { EXIT_CODES } from "../exit.js";
import { YodelError } from "../project.js";
import { COMMAND_SCHEMAS, SCHEMA_VERSION, schemaId } from "../schemas.js";
import { drift } from "../commands/drift.js";
import { lint } from "../commands/lint.js";
import { plan } from "../commands/plan.js";
import { status } from "../commands/status.js";

/** The only verbs a tool may run, and only with the flags {@link runVerb} allows. */
export const READ_VERBS: Readonly<Record<string, Command>> = { status, plan, lint, drift };

/** Never a tool, and never run by one: each writes to a database, a history, the migrations directory or the gate ledger. */
export const WRITE_VERBS = ["apply", "approve", "override", "repair", "revert", "rebase", "new", "checkpoint", "init"] as const;

/** Flags that make a read verb write: a replay database, a checksum, a forge comment, the Op's Apply step. */
const WRITE_FLAGS = ["--replay", "--reset", "--reset-shared", "--keep", "--update-checksum", "--comment", "--execute"];

export interface ToolEnvelope {
  schema: typeof SCHEMA_VERSION;
  tool: string;
  /** The command line the tool ran. */
  command: string;
  /** Its exit code: the same as on a terminal. */
  exit: number;
  /** What it printed with --json; null when it printed nothing to parse. */
  results: unknown;
  /** The `$id` of the schema `results` follows. */
  resultsSchema: string;
  /** What it wrote to stderr: why it failed, when `results` is null, else notices. */
  error?: string;
  /** Steps that are a person's, with the command they run. An agent shows them and never runs them. */
  forPerson?: Array<{ action: string; command: string }>;
}

export interface YodelTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** The yodel verbs the tool runs. */
  verbs: readonly string[];
  handler: (args: Record<string, unknown>) => Promise<ToolEnvelope>;
}

/** Throws when any tool could write: a write verb by name, a verb outside {@link READ_VERBS}, or no read-only annotation. */
export function assertReadOnly(tools: readonly YodelTool[]): void {
  const problems: string[] = [];
  for (const t of tools) {
    const named = WRITE_VERBS.find((v) => t.name === v || t.name.startsWith(`${v}_`) || t.name.endsWith(`_${v}`));
    if (named) problems.push(`tool ${t.name} is named for yodel ${named}, which writes`);
    for (const v of t.verbs) if (!Object.hasOwn(READ_VERBS, v)) problems.push(`tool ${t.name} runs yodel ${v}, which is not one of the read verbs (${Object.keys(READ_VERBS).join(", ")})`);
    if (!t.annotations.readOnlyHint || t.annotations.destructiveHint === true) problems.push(`tool ${t.name} is not annotated read-only`);
  }
  if (problems.length > 0) throw new YodelError(`refused to start: yodel mcp serves read-only tools only, and ${problems.join("; ")}`);
}

/** Runs a read verb in this process with `--json` and captures what it prints. */
export async function runVerb(verb: string, args: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const command = Object.hasOwn(READ_VERBS, verb) ? READ_VERBS[verb] : undefined;
  if (!command) throw new YodelError(`yodel mcp runs only ${Object.keys(READ_VERBS).join(", ")}; not ${verb}`);
  const flag = args.map((a) => a.split("=")[0] ?? a).find((a) => WRITE_FLAGS.includes(a));
  if (flag) throw new YodelError(`yodel mcp does not run yodel ${verb} ${flag}: it writes`);
  let out = "";
  let err = "";
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const code = await command.run([...args, "--json"], io);
  return { code, out, err };
}

const parse = (text: string): unknown => {
  try {
    return text.trim() === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};

/** `--dir` when the server was started for a project elsewhere. */
const dirArgs = (dir: string): string[] => ["--dir", dir];

const envArg = (args: Record<string, unknown>, required: boolean): string | undefined => {
  const env = args.env;
  if (env === undefined && !required) return undefined;
  if (typeof env !== "string" || !/^[\w.-]+$/.test(env)) throw new YodelError("env: expected the name of an environment in chant.config.ts");
  return env;
};

async function envelope(tool: string, verb: string, args: string[], schema: string, shape: (results: unknown) => unknown = (r) => r): Promise<ToolEnvelope> {
  const ran = await runVerb(verb, args);
  const parsed = parse(ran.out);
  const results = parsed === null ? null : shape(parsed);
  return {
    schema: SCHEMA_VERSION,
    tool,
    command: ["yodel", verb, ...args.filter((a, i) => a !== "--dir" && args[i - 1] !== "--dir"), "--json"].join(" "),
    exit: ran.code,
    results,
    resultsSchema: schema,
    ...(ran.err.trim() !== "" ? { error: ran.err.trim() } : {}),
  };
}

const envInput = (required: boolean, what: string) => ({
  type: "object" as const,
  properties: { env: { type: "string", description: what } },
  ...(required ? { required: ["env"] } : {}),
  additionalProperties: false,
});

interface PlanResults {
  approve?: unknown;
  policy?: Array<{ id: string; outcome: string }>;
}

/** A plan's steps that are a person's: overriding each policy rule that denies it (when it should not stand), and approving it. */
export function personSteps(env: string, plan: PlanResults | null): NonNullable<ToolEnvelope["forPerson"]> {
  const steps = (plan?.policy ?? [])
    .filter((r) => r.outcome === "denied")
    .map((r) => ({ action: `override policy rule ${r.id}, if a person on policy.overriders decides it should not stand`, command: `yodel override ${env} --rule ${r.id} --reason "<why>"` }));
  if (typeof plan?.approve === "string") steps.push({ action: "approve this plan, after reading it", command: plan.approve });
  return steps;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const ENV = "The environment, as chant.config.ts names it.";

/** The tools, for the project in `dir`. */
export function yodelTools(dir: string): YodelTool[] {
  return [
    {
      name: "status",
      description: `yodel status <env> --json: applied, pending, out-of-order and part-way migrations, checksum mismatches, and the plan digest apply would ask approval for. Exit 3 when migrations are pending, 4 when apply would refuse. results: ${schemaId(COMMAND_SCHEMAS.status)}`,
      inputSchema: envInput(true, ENV),
      annotations: READ_ONLY,
      verbs: ["status"],
      handler: (a) => envelope("status", "status", [envArg(a, true) as string, ...dirArgs(dir)], schemaId(COMMAND_SCHEMAS.status)),
    },
    {
      name: "plan",
      description: `yodel plan <env> --json: what yodel apply would run and the plan digest. When a person must approve the plan, or may override a policy rule that denies it, forPerson has the command they run. Never run those commands: approvals and overrides belong to people. results: ${schemaId(COMMAND_SCHEMAS.plan)}`,
      inputSchema: envInput(true, ENV),
      annotations: READ_ONLY,
      verbs: ["plan"],
      handler: async (a) => {
        const env = envArg(a, true) as string;
        const e = await envelope("plan", "plan", [env, ...dirArgs(dir)], schemaId(COMMAND_SCHEMAS.plan));
        const forPerson = personSteps(env, e.results as PlanResults | null);
        return forPerson.length > 0 ? { ...e, forPerson } : e;
      },
    },
    {
      name: "lint",
      description: `yodel lint [--env <env>] --json: the lint findings and silences; with env, also against that environment's history. Exit 3 on an error finding. The replay check is not offered: it writes to a database. results: ${schemaId(COMMAND_SCHEMAS.lint)}`,
      inputSchema: envInput(false, `${ENV} Optional: compare the migrations with its history.`),
      annotations: READ_ONLY,
      verbs: ["lint"],
      handler: (a) => {
        const env = envArg(a, false);
        return envelope("lint", "lint", [...(env ? ["--env", env] : []), ...dirArgs(dir)], schemaId(COMMAND_SCHEMAS.lint));
      },
    },
    {
      name: "drift",
      description: `yodel drift <env> --json: the declared objects changed out of band or gone. Exit 2 on drift. results: ${schemaId(COMMAND_SCHEMAS.drift)}`,
      inputSchema: envInput(true, ENV),
      annotations: READ_ONLY,
      verbs: ["drift"],
      handler: (a) => envelope("drift", "drift", [envArg(a, true) as string, ...dirArgs(dir)], schemaId(COMMAND_SCHEMAS.drift)),
    },
    {
      name: "history",
      description: `The migrations an environment's history records applied: who applied each, when, under which plan digest, and any repairs. From yodel status <env> --json. results: ${schemaId("mcp")}#/$defs/history`,
      inputSchema: envInput(true, ENV),
      annotations: READ_ONLY,
      verbs: ["status"],
      handler: (a) =>
        envelope("history", "status", [envArg(a, true) as string, ...dirArgs(dir)], `${schemaId("mcp")}#/$defs/history`, (r) => {
          const s = r as Record<string, unknown>;
          return { environment: s.environment, ...(s.server ? { server: s.server } : {}), history: s.history, applied: s.applied };
        }),
    },
    {
      name: "explain",
      description: `What a lint rule checks and whether it can be silenced (topic: the rule's id, as a finding names it), or what an exit code means (topic: 0 to 5). results: ${schemaId("mcp")}#/$defs/explain`,
      inputSchema: { type: "object", properties: { topic: { type: "string", description: "A lint rule id (pg-lock, checksum, ...) or an exit code (0 to 5)." } }, required: ["topic"], additionalProperties: false },
      annotations: READ_ONLY,
      verbs: ["lint"],
      handler: async (a) => {
        const topic = typeof a.topic === "string" ? a.topic.trim() : "";
        const schema = `${schemaId("mcp")}#/$defs/explain`;
        const exit = EXIT_CODES.find(([code]) => String(code) === topic);
        if (exit) {
          return { schema: SCHEMA_VERSION, tool: "explain", command: "yodel --help", exit: 0, resultsSchema: schema, results: { topic, kind: "exit-code", code: exit[0], meaning: exit[1], docs: `${DOCS_URL}#the-commands` } };
        }
        const e = await envelope("explain", "lint", ["--rules", ...dirArgs(dir)], schema, (r) => {
          const rule = (r as Array<{ id: string }>).find((x) => x.id === topic);
          return rule ? { topic, kind: "lint-rule", rule, docs: `${DOCS_URL}lint/` } : null;
        });
        return e.results === null && e.exit === 0 ? { ...e, exit: 1, error: `no lint rule or exit code ${JSON.stringify(topic)}; yodel lint --rules lists the rules` } : e;
      },
    },
  ];
}
