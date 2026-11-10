/**
 * `yodel mcp` (#58, #297): the tools chant's server gets from yodel's hook
 * are read-only only, the hook refuses a tool that writes, and each tool's
 * result is an envelope that validates against schemas/mcp.schema.json,
 * with results that validate against the schema it names. Under BREAK=1 the
 * build lists an approve tool, and the tool-list check fails. yodel's own
 * stdio server left in 0.12 (#303); YODEL_OWN_MCP is refused.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS, yodelMcpHook } from "../src/mcp/chant-hook.js";
import { assertReadOnly, personSteps, READ_VERBS, runVerb, WRITE_VERBS, yodelTools, type ToolEnvelope, type YodelTool } from "../src/mcp/tools.js";
import { SCHEMA_NAMES, readSchema, schemaId } from "../src/schemas.js";
// @ts-expect-error docs-site/prompts.mjs is plain JavaScript, with no types
import { neverLine } from "../docs-site/prompts.mjs";
import { projectFrom, yodel } from "./helpers/run.js";

const broken = !!process.env.BREAK && process.env.BREAK !== "0";

/** A tool that approves: what a build must never list. */
const approveTool = (over: Partial<YodelTool> = {}): YodelTool => ({
  name: "approve",
  description: "approve the plan",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  verbs: ["status"],
  handler: () => Promise.reject(new Error("never")),
  ...over,
});

/** The tools a build of yodel mcp serves; under BREAK=1, one that approves as well. */
const built = (dir: string): YodelTool[] => [...yodelTools(dir), ...(broken ? [approveTool()] : [])];

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
for (const name of SCHEMA_NAMES) ajv.addSchema(readSchema(name));
const problems = (ref: string, doc: unknown): string[] => {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`no schema ${ref}`);
  return validate(doc) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`);
};

/** Calls each tool by name with its arguments, as chant's server does, and resolves to the envelopes. */
async function call(tools: YodelTool[], calls: Array<[string, Record<string, unknown>]>): Promise<ToolEnvelope[]> {
  const out: ToolEnvelope[] = [];
  for (const [name, args] of calls) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    out.push(await tool.handler(args));
  }
  return out;
}

describe("yodel mcp", () => {
  let project: { dir: string; dispose: () => void };
  beforeAll(() => {
    project = projectFrom("lint-clickhouse");
  });
  afterAll(() => {
    project.dispose();
  });

  it("lists read-only tools only: none applies, approves, repairs, rebases or writes", () => {
    const tools = built(project.dir);
    expect(tools.map((t) => t.name).sort()).toEqual(["drift", "explain", "history", "lint", "plan", "status"]);
    for (const t of tools) {
      expect(WRITE_VERBS as readonly string[]).not.toContain(t.name);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(yodelMcpHook(project.dir, tools).tools().map((t) => t.readOnly)).toEqual(tools.map(() => true));
    expect(Object.keys(READ_VERBS).sort()).toEqual(["drift", "lint", "plan", "status"]);
  });

  it("refuses to start with a tool named approve, apply, repair or rebase, one that runs a write verb, or one not marked read-only", () => {
    for (const name of ["approve", "apply", "repair", "rebase", "override", "new", "init", "apply_prod"]) {
      expect(() => yodelMcpHook(".", [...yodelTools("."), approveTool({ name })]), name).toThrow(/refused to start: yodel mcp serves read-only tools only/);
    }
    expect(() => {
      assertReadOnly([approveTool({ name: "peek", verbs: ["apply"] })]);
    }).toThrow(/runs yodel apply, which is not one of the read verbs/);
    expect(() => {
      assertReadOnly([approveTool({ name: "peek", annotations: { readOnlyHint: false } })]);
    }).toThrow(/not annotated read-only/);
    expect(() => {
      assertReadOnly(yodelTools("."));
    }).not.toThrow();
  });

  it("never runs a write verb or a flag that writes", async () => {
    await expect(runVerb("apply", ["dev"])).rejects.toThrow(/runs only status, plan, lint, drift; not apply/);
    await expect(runVerb("approve", ["dev"])).rejects.toThrow(/not approve/);
    await expect(runVerb("lint", ["--replay", "dev"])).rejects.toThrow(/--replay: it writes/);
    await expect(runVerb("lint", ["--update-checksum=x"])).rejects.toThrow(/--update-checksum: it writes/);
    await expect(runVerb("plan", ["dev", "--pr-note", "out"])).rejects.toThrow(/--pr-note: it writes/);
  });

  it("answers each tool with an envelope its schema validates, results included", async () => {
    const envelopes = await call(yodelTools(project.dir), [
      ["lint", {}],
      ["explain", { topic: "checksum" }],
      ["explain", { topic: "3" }],
      ["explain", { topic: "no-such-rule" }],
      ["status", { env: "nowhere" }],
    ]);
    for (const e of envelopes) {
      expect(problems(schemaId("mcp"), e), JSON.stringify(e)).toEqual([]);
      if (e.results !== null) expect(problems(e.resultsSchema, e.results), JSON.stringify(e.results)).toEqual([]);
    }
    const [lint, rule, exit, unknown, status] = envelopes;
    expect(lint).toMatchObject({ tool: "lint", exit: 0, command: "yodel lint --json", resultsSchema: schemaId("lint"), results: { status: "passed" } });
    expect(rule).toMatchObject({ tool: "explain", exit: 0, results: { kind: "lint-rule", rule: { id: "checksum", silenceable: false } } });
    expect(exit).toMatchObject({ results: { kind: "exit-code", code: 3 } });
    expect(unknown).toMatchObject({ exit: 1, results: null, error: expect.stringMatching(/no lint rule or exit code "no-such-rule"/) as unknown });
    expect(status).toMatchObject({ tool: "status", exit: 1, results: null, command: "yodel status nowhere --json" });
  }, 60_000);

  it("puts the approve command a plan shows in forPerson, and says in its instructions that a person runs it", () => {
    const tools = yodelTools(project.dir);
    const plan = tools.find((t) => t.name === "plan") as YodelTool;
    expect(plan.description).toMatch(/Never run those commands/);
    expect(personSteps("prod", { approve: "chant approve migrate-prod approve --plan sha256:d", policy: [{ id: "no-drops", outcome: "denied" }, { id: "online", outcome: "allowed" }] })).toEqual([
      { action: expect.stringMatching(/^override policy rule no-drops/) as unknown, command: 'yodel override prod --rule no-drops --reason "<why>"' },
      { action: "approve this plan, after reading it", command: "chant approve migrate-prod approve --plan sha256:d" },
    ]);
    expect(personSteps("prod", { planDigest: "sha256:d" } as never)).toEqual([]);
    expect(INSTRUCTIONS, "the never-line from docs-site/prompts.mjs, word for word").toContain(neverLine as string);
    expect(neverLine).toContain("never edit the `chant/lifecycle` branch");
  });

  it("yodel mcp --help says what it serves and that nothing writes", async () => {
    const help = await yodel(["mcp", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: yodel mcp [--dir <project>]");
    expect(help.out).toMatch(/no tool that applies, approves, repairs, rebases or writes a migration/);
    expect(help.out).toContain("chant serve mcp");
  });

  it("refuses YODEL_OWN_MCP by name: yodel's own server is gone (#303)", async () => {
    const saved = process.env.YODEL_OWN_MCP;
    process.env.YODEL_OWN_MCP = "1";
    try {
      const ran = await yodel(["mcp", "--dir", project.dir]);
      expect(ran.code).toBe(1);
      expect(ran.err).toMatch(/refused: YODEL_OWN_MCP is set, and yodel's own MCP server is gone/);
    } finally {
      if (saved === undefined) delete process.env.YODEL_OWN_MCP;
      else process.env.YODEL_OWN_MCP = saved;
    }
  });
});
