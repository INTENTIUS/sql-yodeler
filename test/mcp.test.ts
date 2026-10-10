/**
 * `yodel mcp` (#58): the server lists read-only tools only, refuses to start
 * with a tool that writes, and each tool's result is an envelope that
 * validates against schemas/mcp.schema.json, with results that validate
 * against the schema it names. Under BREAK=1 the build lists an approve tool,
 * and the tool-list check fails.
 */

import { PassThrough } from "node:stream";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS, YodelMcpServer } from "../src/mcp/server.js";
import { assertReadOnly, READ_VERBS, runVerb, WRITE_VERBS, yodelTools, type YodelTool } from "../src/mcp/tools.js";
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

/** Sends each message to a server serving `tools`, newline-delimited as on stdio, and resolves to the responses. */
async function converse(tools: YodelTool[], messages: unknown[]): Promise<Array<{ id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }>> {
  const server = new YodelMcpServer(tools);
  const input = new PassThrough();
  const lines: string[] = [];
  const log = console.log;
  const done = server.serve(input, (l) => lines.push(l));
  for (const m of messages) input.write(`${typeof m === "string" ? m : JSON.stringify(m)}\n`);
  input.end();
  await done;
  console.log = log;
  return lines.map((l) => JSON.parse(l) as never);
}

describe("yodel mcp", () => {
  let project: { dir: string; dispose: () => void };
  beforeAll(() => {
    project = projectFrom("lint-clickhouse");
  });
  afterAll(() => {
    project.dispose();
  });

  it("lists read-only tools only: none applies, approves, repairs, rebases or writes", async () => {
    const [init, list] = await converse(built(project.dir), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(init?.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "yodel" }, capabilities: { tools: {} } });
    const tools = (list?.result?.tools ?? []) as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["drift", "explain", "history", "lint", "plan", "status"]);
    for (const t of tools) {
      expect(WRITE_VERBS as readonly string[]).not.toContain(t.name);
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(Object.keys(READ_VERBS).sort()).toEqual(["drift", "lint", "plan", "status"]);
  });

  it("refuses to start with a tool named approve, apply, repair or rebase, one that runs a write verb, or one not marked read-only", () => {
    for (const name of ["approve", "apply", "repair", "rebase", "override", "new", "init", "apply_prod"]) {
      expect(() => new YodelMcpServer([...yodelTools("."), approveTool({ name })]), name).toThrow(/refused to start: yodel mcp serves read-only tools only/);
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
    await expect(runVerb("plan", ["dev", "--comment"])).rejects.toThrow(/--comment: it writes/);
  });

  it("answers each tool with an envelope its schema validates, results included", async () => {
    const responses = await converse(yodelTools(project.dir), [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lint", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "explain", arguments: { topic: "checksum" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "explain", arguments: { topic: "3" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "explain", arguments: { topic: "no-such-rule" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status", arguments: { env: "nowhere" } } },
    ]);
    const envelopes = responses.map((r) => r.result?.structuredContent as { tool: string; exit: number; results: unknown; resultsSchema: string; command: string; error?: string });
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
    expect(responses[4]?.result?.isError).toBe(true);
  }, 60_000);

  it("puts the approve command a plan shows in forPerson, and says in its instructions that a person runs it", () => {
    const tools = yodelTools(project.dir);
    const plan = tools.find((t) => t.name === "plan") as YodelTool;
    expect(plan.description).toMatch(/Never run that command/);
    expect(INSTRUCTIONS, "the never-line from docs-site/prompts.mjs, word for word").toContain(neverLine as string);
    expect(neverLine).toContain("never edit the `chant/lifecycle` branch");
  });

  it("refuses an unknown tool and an unknown method, and answers a parse error", async () => {
    const [tool, method, parse] = await converse(yodelTools(project.dir), [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apply", arguments: { env: "prod" } } },
      { jsonrpc: "2.0", id: 2, method: "resources/write" },
      "{not json",
    ]);
    expect(tool?.error).toMatchObject({ code: -32602, message: expect.stringMatching(/unknown tool "apply"/) as unknown });
    expect(method?.error?.code).toBe(-32601);
    expect(parse?.error?.code).toBe(-32700);
  });

  it("yodel mcp --help says what it serves and that nothing writes", async () => {
    const help = await yodel(["mcp", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: yodel mcp [--dir <project>]");
    expect(help.out).toMatch(/no tool that applies, approves, repairs, rebases or writes a migration/);
  });
});
