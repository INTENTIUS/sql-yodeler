/**
 * `yodel mcp`: a Model Context Protocol server on stdio, newline-delimited
 * JSON-RPC 2.0. It answers `initialize`, `ping`, `tools/list` and
 * `tools/call`, and serves only the read-only tools of ./tools.ts; the
 * constructor refuses any other list ({@link assertReadOnly}).
 */

import { createInterface } from "node:readline";
import { version } from "../version.js";
import { assertReadOnly, type YodelTool } from "./tools.js";

/** Protocol revisions this server answers with, newest first; a client asking for another gets the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const INSTRUCTIONS =
  "Read-only tools over a SQL Yodeler project: status, plan, lint, drift, history and explain. Each result is an envelope whose results follow the JSON Schema named in resultsSchema. " +
  "Nothing here applies, approves, overrides a policy rule, repairs, rebases or writes a migration. A plan carries the commands that are a person's (approve, override) in forPerson: show them to the person, and never run them. " +
  "Never run `yodel apply` against a shared environment, never run `chant approve`, `yodel approve` or `yodel override`, never edit the `chant/lifecycle` branch or `.chant/allowed_signers`, never merge; approvals and applies belong to people.";

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: unknown;
  params?: Record<string, unknown>;
}

type Response = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export class YodelMcpServer {
  private readonly tools: ReadonlyMap<string, YodelTool>;

  constructor(tools: readonly YodelTool[]) {
    assertReadOnly(tools);
    this.tools = new Map(tools.map((t) => [t.name, t]));
  }

  /** What `tools/list` answers: name, description, input schema and annotations. */
  list(): Array<Pick<YodelTool, "name" | "description" | "inputSchema" | "annotations">> {
    return [...this.tools.values()].map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  }

  /** Answers one message; `null` for a notification (no id), which gets no response. */
  async handle(message: Request): Promise<Response | null> {
    if (message.id === undefined) return null;
    const id = message.id;
    try {
      return { jsonrpc: "2.0", id, result: await this.dispatch(message.method, message.params ?? {}) };
    } catch (e) {
      const code = e instanceof MethodNotFound ? -32601 : e instanceof InvalidParams ? -32602 : -32603;
      return { jsonrpc: "2.0", id, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  private async dispatch(method: unknown, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        return {
          protocolVersion: asked && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "yodel", version: version() },
          instructions: INSTRUCTIONS,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.list() };
      case "tools/call":
        return this.call(params);
      default:
        throw new MethodNotFound(`unknown method ${JSON.stringify(method)}`);
    }
  }

  private async call(params: Record<string, unknown>): Promise<unknown> {
    const name = params.name;
    const tool = typeof name === "string" ? this.tools.get(name) : undefined;
    if (!tool) throw new InvalidParams(`unknown tool ${JSON.stringify(name)}; yodel mcp serves ${[...this.tools.keys()].join(", ")}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const envelope = await tool.handler(args);
      return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }], structuredContent: envelope, isError: envelope.results === null };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  }

  /** Serves stdin and stdout until stdin closes. Anything else the process logs goes to stderr. */
  serve(input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (l) => process.stdout.write(l)): Promise<void> {
    // stdout carries the protocol only: a project's config or Op printing with console.log would break it.
    console.log = console.info = (...a: unknown[]) => {
      process.stderr.write(`${a.map(String).join(" ")}\n`);
    };
    const rl = createInterface({ input, terminal: false });
    let queue = Promise.resolve();
    rl.on("line", (line) => {
      if (line.trim() === "") return;
      // One request at a time, in order: the tools run commands in this process.
      queue = queue.then(async () => {
        let message: Request;
        try {
          message = JSON.parse(line) as Request;
        } catch {
          write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
          return;
        }
        const response = await this.handle(message);
        if (response) write(`${JSON.stringify(response)}\n`);
      });
    });
    return new Promise((resolve) => rl.on("close", () => void queue.then(resolve)));
  }
}

class MethodNotFound extends Error {}
class InvalidParams extends Error {}
