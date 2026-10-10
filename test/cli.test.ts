import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { help, main } from "../src/cli.js";
import type { Command, Io } from "../src/command.js";
import { commands } from "../src/commands/index.js";
import { fixture } from "./helpers/run.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

async function run(argv: string[], list?: readonly Command[]) {
  let out = "";
  let err = "";
  const io: Io = {
    out: (t) => (out += t),
    err: (t) => (err += t),
  };
  const code = await (list ? main(argv, io, list) : main(argv, io));
  return { code, out, err };
}

const verbs = ["init", "plan", "apply", "approve", "override", "new", "lint", "status", "report", "drift", "docs", "rebase", "repair", "mcp"];
const envVerbs = ["plan", "apply", "status", "drift"];
const built = [...envVerbs, "approve", "override", "new", "init", "lint", "report", "docs", "rebase", "repair", "mcp"];
const notBuilt = verbs.filter((v) => !built.includes(v));

describe("yodel", () => {
  it("prints the package version", async () => {
    for (const flag of ["--version", "-v"]) {
      expect(await run([flag])).toEqual({ code: 0, out: `${pkg.version}\n`, err: "" });
    }
  });

  it("lists every verb from the design in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(commands.map((c) => c.name)).toEqual(verbs);
    for (const verb of notBuilt) {
      expect(out).toMatch(new RegExp(`^  ${verb} +.+\\(not implemented yet\\)$`, "m"));
    }
    for (const verb of built) {
      expect(out).toMatch(new RegExp(`^  ${verb} +.+$`, "m"));
      expect(out).not.toMatch(new RegExp(`^  ${verb} +.+\\(not implemented yet\\)$`, "m"));
    }
  });

  it("prints help to stderr and fails with no command", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(help());
  });

  it("rejects an unknown command and an unknown option", async () => {
    const unknownVerb = await run(["migrate"]);
    expect(unknownVerb.code).toBe(1);
    expect(unknownVerb.err).toContain('unknown command "migrate"');

    const unknownFlag = await run(["--nope"]);
    expect(unknownFlag.code).toBe(1);
    expect(unknownFlag.err).toContain("--nope");
  });

  it("says a verb is not implemented yet", async () => {
    for (const verb of notBuilt) {
      const { code, err } = await run([verb, "prod"]);
      expect(code).toBe(2);
      expect(err).toBe(`yodel ${verb}: not implemented yet\n`);
    }
  });

  it("takes exactly one environment for plan, apply and drift", async () => {
    for (const verb of envVerbs) {
      for (const args of [[], ["dev", "prod"]]) {
        const { code, err } = await run([verb, ...args]);
        expect(code).toBe(1);
        expect(err).toContain(`usage: yodel ${verb} <env> [--json] [--dir <project>]`);
      }
      const flag = await run([verb, "dev", "--nope"]);
      expect(flag.code).toBe(1);
      expect(flag.err).toContain("--nope");
    }
  });

  it("documents the exit codes in each built verb's --help", async () => {
    for (const verb of envVerbs) {
      const { code, out } = await run([verb, "--help"]);
      expect(code).toBe(0);
      expect(out).toMatch(new RegExp(`^usage: yodel ${verb} <env>`));
      expect(out).toMatch(/Exit codes:\n {2}0 [\s\S]*\n {2}2 [\s\S]*\n {2}1 /);
    }
    expect((await run(["apply", "-h"])).out).toContain("  3  stopped at the gate");
    expect((await run(["new", "--help"])).out).toMatch(/^usage: yodel new <name>[\s\S]*Exit codes:\n {2}0 [\s\S]*\n {2}1 /);
  });

  it("fails plan, apply and drift outside a project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodel-cli-"));
    try {
      for (const verb of built) {
        const args = verb === "new" ? ["add-country"] : verb === "init" ? ["--from", "dev"] : verb === "repair" ? ["20261009T1000-one", "--reason", "x", "dev"] : verb === "lint" || verb === "mcp" || verb === "docs" ? [] : ["dev"];
        const { code, err } = await run([verb, ...args, "--dir", dir]);
        expect(code).toBe(1);
        expect(err).toMatch(new RegExp(`^yodel ${verb}: no chant.config.ts in `));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the declared environments for an unknown one", async () => {
    const { code, err } = await run(["plan", "prod", "--dir", fixture("clickhouse")]);
    expect(code).toBe(1);
    expect(err).toMatch(/no environment "prod".*declared: e2e/);
  });

  it("passes the arguments after the verb to the command", async () => {
    let seen: string[] = [];
    const echo: Command = {
      name: "echo",
      summary: "test",
      implemented: true,
      run: (args) => {
        seen = args;
        return Promise.resolve(0);
      },
    };
    expect((await run(["echo", "prod", "--dry-run"], [echo])).code).toBe(0);
    expect(seen).toEqual(["prod", "--dry-run"]);
    expect(help([echo])).not.toContain("not implemented");
  });
});
