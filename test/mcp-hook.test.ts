/**
 * #297: yodel's MCP tools on chant's server through the product tool hook
 * (chant#4555), read-only; traces through chant's OTLP exporter with the
 * `yodel` prefix; notify in yodel's words.
 */

import { describe, expect, it } from "vitest";
import { YODEL_WORDS } from "../src/ci-words.js";
import { asChantTool, chantHooks, serveOnChant, useChantTraces, yodelMcpHook, type ChantHooks, type YodelMcpHook } from "../src/mcp/chant-hook.js";
import { yodelTools, type YodelTool } from "../src/mcp/tools.js";
import { HEADER_PREFIX } from "../src/notify/verify.js";

describe("yodel's tools on chant's MCP server (#297)", () => {
  it("are the same tools, each declared read-only, under the product yodel", () => {
    const hook = yodelMcpHook(process.cwd());
    expect(hook.product).toBe("yodel");
    expect(hook.readOnly).toBe(true);
    const tools = hook.tools();
    expect(tools.map((t) => t.name)).toEqual(yodelTools(process.cwd()).map((t) => t.name));
    expect(tools.map((t) => t.readOnly)).toEqual(tools.map(() => true));
  });

  it("refuse a tool that could write before chant sees it (assertReadOnly)", () => {
    const [first] = yodelTools(process.cwd());
    if (!first) throw new Error("no tools");
    const writer: YodelTool = { ...first, name: "apply", verbs: ["apply"] };
    expect(() => yodelMcpHook(process.cwd(), [writer])).toThrow();
  });

  it("take no name chant's read-only server would refuse", async () => {
    const specifier: string = "@intentius/chant/cli/mcp/product-tools";
    const mod = (await import(specifier).catch(() => undefined)) as { productToolWriteWord?: (n: string) => string | undefined } | undefined;
    if (!mod?.productToolWriteWord) return;
    for (const t of yodelMcpHook(process.cwd()).tools()) expect(mod.productToolWriteWord(t.name), t.name).toBeUndefined();
  });

  it("keep the input schema chant takes", () => {
    const [first] = yodelTools(process.cwd());
    if (!first) throw new Error("no tools");
    const t = asChantTool(first);
    expect(t.inputSchema.type).toBe("object");
    expect(Object.keys(t.inputSchema)).not.toContain("additionalProperties");
  });

  it("start chant serve mcp --read-only in this process with yodel's words and the hook", async () => {
    const calls: Array<{ argv: string[]; words: unknown; hook: YodelMcpHook | undefined }> = [];
    const fake: ChantHooks = {
      runChantInProcess: (argv, words, options) => {
        calls.push({ argv, words, hook: options.mcp });
        return Promise.resolve(0);
      },
      configureOtlp: () => undefined,
      PRODUCT_MCP_HOOK_FLOOR: "0.0.0",
    };
    const before = process.cwd();
    try {
      expect(await serveOnChant(before, fake)).toBe(0);
    } finally {
      process.chdir(before);
    }
    expect(calls[0]?.argv).toEqual(["serve", "mcp", "--read-only"]);
    expect(calls[0]?.words).toBe(YODEL_WORDS);
    expect(calls[0]?.hook?.product).toBe("yodel");
  });

  it("is found only on a chant that has the hook", async () => {
    const c = await chantHooks();
    if (c) expect(typeof c.configureOtlp).toBe("function");
    else expect(await serveOnChant(process.cwd())).toBeUndefined();
  });
});

describe("traces (#297)", () => {
  it("are configured only when an OTLP endpoint is set", async () => {
    expect(await useChantTraces({})).toBe(false);
  });
});

describe("notify in yodel's words (#297)", () => {
  it("signs under the product word's header names", () => {
    expect(HEADER_PREFIX).toBe(`x-${YODEL_WORDS.product}`);
  });
});
