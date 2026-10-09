import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { help, main } from "../src/cli.js";
import type { Command, Io } from "../src/command.js";
import { commands } from "../src/commands/index.js";

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

const verbs = ["init", "plan", "apply", "new", "lint", "status", "drift", "rebase", "repair"];

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
    for (const verb of verbs) {
      expect(out).toMatch(new RegExp(`^  ${verb} +.+\\(not implemented yet\\)$`, "m"));
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
    for (const verb of verbs) {
      const { code, err } = await run([verb, "prod"]);
      expect(code).toBe(2);
      expect(err).toBe(`yodel ${verb}: not implemented yet\n`);
    }
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
