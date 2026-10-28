/**
 * yodel's MCP tools on chant's server, and its traces through chant's OTLP
 * exporter (#297, chant#4555, chant#4543).
 *
 * With a chant that has the product tool hook, `yodel mcp` runs `chant
 * serve mcp --read-only` in this process through `runChantInProcess` with
 * yodel's words and {@link yodelMcpHook}: chant serves its own read-only
 * tools over the ledger and graph, and yodel's tools beside them as
 * `yodel:status`, `yodel:plan`, `yodel:lint`, `yodel:drift`,
 * `yodel:history` and `yodel:explain`. Each declares `readOnly: true`; chant
 * refuses to start a read-only server with a product tool named as a write,
 * and yodel's own {@link assertReadOnly} refuses the list first, as its own
 * server did. Without the hook `yodel mcp` serves its own stdio server, as
 * before.
 *
 * Traces: with `OTEL_EXPORTER_OTLP_ENDPOINT` set, {@link useChantTraces}
 * configures chant's exporter with the `yodel` prefix once, so a wave job
 * that `yodel chant run wave` runs sends its trace with `yodel.*`
 * attributes. Without the exporter nothing is sent, as before.
 *
 * Both are imported lazily, with the specifiers in variables, so this
 * compiles and runs on a published chant without them.
 */
import { YODEL_WORDS } from "../ci-words.js";
import { assertReadOnly, yodelTools, type YodelTool } from "./tools.js";
import { INSTRUCTIONS } from "./server.js";

/** chant's `McpToolContribution`, the parts yodel fills. */
export interface ChantMcpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  readOnly: true;
}

/** chant's `ProductMcpHook`, the parts yodel fills. */
export interface YodelMcpHook {
  product: string;
  tools: () => ChantMcpTool[];
  readOnly: true;
  instructions: string;
}

/** What yodel calls of `@intentius/chant/ci-product` for the hook and the traces. */
export interface ChantHooks {
  runChantInProcess: (argv: string[], words: unknown, options: { mcp?: YodelMcpHook }) => Promise<number>;
  configureOtlp: (opts: { prefix: string }) => unknown;
  PRODUCT_MCP_HOOK_FLOOR: string;
}

let hooks: Promise<ChantHooks | undefined> | undefined;

/** chant's product tool hook and OTLP exporter, once, or undefined when the installed chant has neither (a release before chant#4555). */
export function chantHooks(): Promise<ChantHooks | undefined> {
  hooks ??= (async () => {
    const specifier = "@intentius/chant/ci-product";
    try {
      const m = (await import(specifier)) as Partial<ChantHooks>;
      return typeof m.runChantInProcess === "function" && typeof m.configureOtlp === "function" && typeof m.PRODUCT_MCP_HOOK_FLOOR === "string" ? (m as ChantHooks) : undefined;
    } catch {
      return undefined;
    }
  })();
  return hooks;
}

/** One of yodel's tools as chant's contribution: the same handler, read-only. */
export function asChantTool(t: YodelTool): ChantMcpTool {
  const { type, properties, required } = t.inputSchema;
  return { name: t.name, description: t.description, inputSchema: { type, properties, ...(required ? { required } : {}) }, handler: t.handler, readOnly: true };
}

/** yodel's tools for chant's server, checked read-only before chant sees them. */
export function yodelMcpHook(dir: string, tools: readonly YodelTool[] = yodelTools(dir)): YodelMcpHook {
  assertReadOnly(tools);
  return { product: YODEL_WORDS.product, tools: () => tools.map(asChantTool), readOnly: true, instructions: INSTRUCTIONS };
}

/** Serve yodel's tools on chant's read-only server, from `dir`. Undefined when chant has no hook. */
export async function serveOnChant(dir: string, chant?: ChantHooks): Promise<number | undefined> {
  const c = chant ?? (await chantHooks());
  if (!c) return undefined;
  const hook = yodelMcpHook(dir);
  process.chdir(dir);
  return c.runChantInProcess(["serve", "mcp", "--read-only"], YODEL_WORDS, { mcp: hook });
}

let traced = false;

/** Configure chant's OTLP exporter with yodel's prefix, once, when an endpoint is set and chant has the exporter. */
export async function useChantTraces(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (traced) return true;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) return false;
  const c = await chantHooks();
  if (!c) return false;
  c.configureOtlp({ prefix: YODEL_WORDS.product });
  traced = true;
  return true;
}
