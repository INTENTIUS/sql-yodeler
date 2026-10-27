/**
 * yodel's words for chant's product pipeline (#287): chant accepts them, the
 * bin passes them to chant, a status context reads yodel/plan, and the wave
 * gates keep the names a 0.10.1 ledger holds.
 *
 * `@intentius/chant/ci-product` arrives with chant#4550's release. Against a
 * chant without it, the cases that need it skip, and the rest show yodel
 * works as before.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGateLedger } from "@intentius/chant/lifecycle/gate-ledger";
import { waveGateName } from "@intentius/chant/gated-waves";
import { chantProduct, YODEL_CHANT_BIN, YODEL_WORDS, type ChantProduct } from "../src/ci-words.js";
import { runChantVerb } from "../src/commands/chant.js";
import { main } from "../src/cli.js";
import type { Io } from "../src/command.js";
import { approveCommand } from "../src/approval-mode/index.js";
import { wavesSpec, type Wave } from "../src/ci/render.js";
import { WAVES_PIPELINE } from "../src/waves/record.js";
import { fixture } from "./helpers/run.js";

const specifier = "@intentius/chant/ci-product";
/** chant's product entry, typed loosely: the test reaches more of it than src does. */
const ciProduct = (await import(specifier).catch(() => undefined)) as Record<string, (...args: never[]) => unknown> | undefined;
const hasProduct = typeof ciProduct?.productPipelineJobs === "function";
/** One function of chant's product entry; the cases that call it skip when chant has none. */
const cp = (name: string): ((...args: never[]) => unknown) => {
  const f = ciProduct?.[name];
  if (typeof f !== "function") throw new Error(`chant's product entry has no ${name}`);
  return f;
};
const { opWaveGateName } = (await import("@intentius/chant/op")) as unknown as { opWaveGateName: (spec: unknown, k: number) => string };

const capture = () => {
  let out = "";
  let err = "";
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  return { io, text: () => ({ out, err }) };
};

describe("yodel's words (#287)", () => {
  it("name yodel, environments, no comment command, and sql-yodeler's op and wave gates", () => {
    expect(YODEL_WORDS.product).toBe("yodel");
    expect(YODEL_WORDS.stages.plan).toBe("plan");
    expect(YODEL_WORDS.stages.apply).toBe("apply");
    for (const s of ["check", "drift", "lock", "approval"] as const) expect(YODEL_WORDS.stages[s]).toBe(s);
    expect(YODEL_WORDS.verbs).toEqual({ plan: ["plan", "planned"], apply: ["apply", "applied"] });
    expect(YODEL_WORDS.noun).toEqual(["environment", "environments"]);
    // #285 ruling E: merge only, so no command a comment could start an apply with.
    expect(YODEL_WORDS.commands).toEqual({});
    expect(YODEL_WORDS.op).toBe("yodel-apply");
    expect(YODEL_WORDS.gateName).toBe("yodel-apply-wave-{k}");
    expect(YODEL_WORDS.approval).toBe("per-wave");
    expect(YODEL_WORDS.approve).toBe("yodel approve {target} --plan {digest} {sign}");
    expect(YODEL_WORDS.override).toBe("yodel override {target} --rule {rule} --reason <text>");
    expect(YODEL_WORDS.bin).toBe(YODEL_CHANT_BIN);
  });

  it("the feature-detect finds chant's product entry exactly when the installed chant has it", async () => {
    expect((await chantProduct()) !== undefined).toBe(hasProduct);
  });

  it.skipIf(!hasProduct)("chant's assertProductWords accepts them, and refuses an apply command with no apply job", () => {
    const words = cp("assertProductWords")(YODEL_WORDS as never) as { product: string; commands: Record<string, string>; gateName: string };
    expect(words.product).toBe("yodel");
    expect(words.commands).toEqual({});
    expect(words.gateName).toBe("yodel-apply-wave-{k}");
    expect(() => cp("assertProductWords")({ ...YODEL_WORDS, commands: { apply: "apply" } } as never, { jobs: ["plan"] } as never)).toThrow(/needs a apply job/);
  });

  it.skipIf(!hasProduct)("a chant status context comes out as yodel/plan under the words", async () => {
    const { prStatusContext, withProductWords } = ciProduct as unknown as {
      prStatusContext: (stage: string, member?: string) => string;
      withProductWords: <T>(words: unknown, fn: () => Promise<T>) => Promise<T>;
    };
    expect(prStatusContext("plan")).not.toBe("yodel/plan");
    expect(await withProductWords(YODEL_WORDS, () => Promise.resolve(prStatusContext("plan")))).toBe("yodel/plan");
    expect(await withProductWords(YODEL_WORDS, () => Promise.resolve(prStatusContext("apply", "prod")))).toBe("yodel/apply/prod");
  });

  it.skipIf(!hasProduct)("chant's approve line from the words is yodel approve's own line", () => {
    const words = cp("assertProductWords")(YODEL_WORDS as never);
    const line = (target: string, sign: boolean) =>
      cp("approveLine")(words as never, { op: WAVES_PIPELINE, gate: "yodel-apply-wave-2", digest: "jcs1-sha256:d", target, sign } as never);
    expect(line("prod", false)).toBe(approveCommand("prod", "jcs1-sha256:d"));
    expect(line("prod", true)).toBe(approveCommand("prod", "jcs1-sha256:d", "sealed"));
    expect(line("prod/acme", false)).toBe("yodel approve prod/acme --plan jcs1-sha256:d");
  });
});

describe("yodel chant (#287)", () => {
  it("passes the line and yodel's words to chant in this process when chant has its product entry", async () => {
    const calls: Array<{ argv: string[]; words: unknown }> = [];
    const product = {
      runChantInProcess: (argv: string[], words: unknown) => {
        calls.push({ argv, words });
        return Promise.resolve(3);
      },
    } as unknown as ChantProduct;
    const c = capture();
    const child = () => Promise.reject(new Error("no child when chant runs in process"));
    expect(await runChantVerb(["components", "pr-plan", "--env", "prod"], c.io, { product: () => Promise.resolve(product), child })).toBe(3);
    expect(calls).toEqual([{ argv: ["components", "pr-plan", "--env", "prod"], words: YODEL_WORDS }]);
  });

  it("runs chant in a child, in chant's words, when the installed chant has no product entry", async () => {
    const ran: string[][] = [];
    const c = capture();
    const child = (args: readonly string[], options: { onStdout?: (t: string) => void }) => {
      ran.push([...args]);
      options.onStdout?.("ran\n");
      return Promise.resolve({ code: 0, stdout: "ran\n", stderr: "" });
    };
    expect(await runChantVerb(["run", "wave", "--op", "yodel-apply"], c.io, { product: () => Promise.resolve(undefined), child, cwd: fixture("postgres") })).toBe(0);
    expect(ran).toEqual([["run", "wave", "--op", "yodel-apply"]]);
    expect(c.text().out).toBe("ran\n");
  });

  it("prints its usage, and is reached from yodel's main", async () => {
    const c = capture();
    expect(await main(["chant"], c.io)).toBe(1);
    expect(c.text().err).toContain("usage: yodel chant <chant command>");
    const h = capture();
    expect(await main(["chant", "--help"], h.io)).toBe(0);
    expect(h.text().out).toContain("yodel/plan");
  });
});

describe("wave gate names on chant/lifecycle (#287)", () => {
  const ledger = readFileSync(fixture("ledger-0.10.1/_gates/yodel-apply.jsonl"), "utf8");
  const { pending, resolutions, malformed } = parseGateLedger(ledger);
  const recorded = [...new Set([...pending, ...resolutions].map((r) => r.gate))].sort();
  const waves: Wave[] = [
    { env: "dev", gate: "always" },
    { env: "prod", gate: "always" },
  ];

  it("the 0.10.1 ledger fixture reads, under op yodel-apply", () => {
    expect(malformed).toBe(0);
    expect(new Set([...pending, ...resolutions].map((r) => r.op))).toEqual(new Set([WAVES_PIPELINE]));
    expect(recorded).toEqual(["yodel-apply-wave-1", "yodel-apply-wave-2"]);
  });

  it("yodel's own spec names the same gates", () => {
    const spec = wavesSpec(waves);
    expect(spec.name).toBe(WAVES_PIPELINE);
    expect(waves.map((_, i) => waveGateName(spec.name, i + 1))).toEqual(recorded);
  });

  it.skipIf(!hasProduct)("the spec under yodel's words names the same op and gates, so recorded approvals keep counting", () => {
    const named = cp("productWavesSpec")(wavesSpec(waves) as never, YODEL_WORDS as never) as { name: string; gateName?: string; waves: Array<{ approval?: string }> };
    expect(named.name).toBe(WAVES_PIPELINE);
    expect(waves.map((_, i) => opWaveGateName(named, i + 1))).toEqual(recorded);
    // per-wave: no wave is moved onto the pull request's approval.
    expect(named.waves.every((w) => w.approval !== "pull-request")).toBe(true);
  });
});
