import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.js";
import type { Io } from "../../src/command.js";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const fixture = (name: string) => join(repoRoot, "test", "fixtures", name);

export interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Runs `yodel <argv>` in this process and captures what it writes. */
export async function yodel(argv: string[]): Promise<Ran> {
  let out = "";
  let err = "";
  const io: Io = { out: (t) => (out += t), err: (t) => (err += t) };
  const code = await main(argv, io);
  return { code, out, err };
}

/** `JSON.parse` of a run's stdout. */
export const json = (ran: Ran): unknown => JSON.parse(ran.out);

/**
 * A copy of a fixture project in a temporary directory: its own git
 * repository (Op discovery and the gate ledger live in git), with yodel's
 * node_modules linked in so the project resolves chant and the lexicon.
 */
export function projectFrom(name: string): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `yodel-${name}-`));
  cpSync(fixture(name), dir, { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "yodel e2e");
  git("config", "user.email", "yodel-e2e@example.invalid");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return { dir, dispose: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
