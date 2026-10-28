import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/**
 * Copies `templates/<dialect>` to `dir`, leaving out the template's
 * chant.workspace.json. A project with no declaration of its own (made
 * before 0.11.0 and not upgraded yet, or a member under a declaration above
 * it) is what these cases render: yodel's own lint job, not chant's check
 * hooks. test/template.test.ts reads the templates as they are.
 */
export function copyTemplate(dialect: "clickhouse" | "postgres", dir: string): void {
  cpSync(join(repoRoot, "templates", dialect), dir, { recursive: true, filter: (src) => basename(src) !== "chant.workspace.json" });
}

/** `JSON.parse` of a run's stdout. */
export const json = (ran: Ran): unknown => JSON.parse(ran.out);

/**
 * A copy of a fixture project in a temporary directory: its own git
 * repository (Op discovery and the gate ledger live in git), with yodel's
 * node_modules linked in so the project resolves chant and the lexicon.
 * `edit`, when given, rewrites every file's text before the first commit.
 */
export function projectFrom(name: string, edit?: (text: string) => string): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `yodel-${name}-`));
  cpSync(fixture(name), dir, { recursive: true });
  if (edit) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(entry.parentPath, entry.name);
      writeFileSync(file, edit(readFileSync(file, "utf8")));
    }
  }
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
