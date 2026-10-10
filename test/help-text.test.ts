import { describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { help, main } from "../src/cli.js";
import type { Io } from "../src/command.js";

const capture = () => {
  let out = "";
  let err = "";
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  return { io, out: () => out, err: () => err };
};

describe("help text (#19)", () => {
  it.each(commands.map((c) => c.name))("yodel %s --help fits in 80 columns", async (name) => {
    const c = capture();
    const command = commands.find((x) => x.name === name);
    await command?.run(["--help"], c.io);
    const long = c.out().split("\n").filter((l) => l.length > 80);
    expect(long).toEqual([]);
  });

  it("yodel --help fits in 80 columns and points to each command's help and the docs", () => {
    expect(help().split("\n").filter((l) => l.length > 80)).toEqual([]);
    expect(help()).toContain("yodel <command> --help (or yodel help <command>)");
    expect(help()).toContain("Docs: https://intentius.io/sql-yodeler/");
  });

  it("yodel help is yodel --help, and yodel help <command> is yodel <command> --help", async () => {
    const root = capture();
    expect(await main(["help"], root.io)).toBe(0);
    expect(root.out()).toBe(help());
    const one = capture();
    expect(await main(["help", "status"], one.io)).toBe(0);
    const direct = capture();
    await main(["status", "--help"], direct.io);
    expect(one.out()).toBe(direct.out());
    const unknown = capture();
    expect(await main(["help", "nope"], unknown.io)).toBe(1);
    expect(unknown.err()).toContain('unknown command "nope"');
  });

  it("aligns each command's options", async () => {
    for (const command of commands) {
      const c = capture();
      await command.run(["--help"], c.io);
      const options = c.out().split("\nOptions:\n")[1]?.split("\n\n")[0] ?? "";
      // Each option line's description starts in one column.
      const starts = new Set(options.split("\n").filter((l) => /^ {2}-/.test(l)).map((l) => /^ {2}\S.*?\s{2,}(?=\S)/.exec(l)?.[0].length).filter((n) => n !== undefined));
      expect(starts.size, `${command.name}: ${options}`).toBeLessThanOrEqual(1);
    }
  });
});
