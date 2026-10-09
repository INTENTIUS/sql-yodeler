/**
 * The files `yodel init` writes, and taking them back when a later step
 * fails, so an init that does not finish leaves the project as it found it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** Directories never searched for declarations. */
const SKIP = new Set(["node_modules", "dist", "coverage"]);

/** Whether a file is a declaration chant builds: TypeScript (not a test or a `.d.ts`) or SQL. */
export const isDeclarationFile = (name: string): boolean =>
  (/\.(ts|mts|sql)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name));

/** The declaration files under `dir`, relative to it, sorted. None when `dir` does not exist. */
export function declarationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const path = join(at, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && isDeclarationFile(e.name)) out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Records every file and directory written, with what a file held before,
 * so {@link Journal.undo} puts things back.
 */
export class Journal {
  private readonly steps: Array<() => void> = [];

  /** Makes `dir` and any parents missing, remembering the ones it made. */
  mkdir(dir: string): void {
    const missing: string[] = [];
    for (let d = dir; !existsSync(d); d = dirname(d)) missing.push(d);
    if (missing.length === 0) return;
    mkdirSync(dir, { recursive: true });
    const top = missing[missing.length - 1];
    if (top !== undefined) this.steps.push(() => { rmSync(top, { recursive: true, force: true }); });
  }

  /** Writes a file, remembering what was there. */
  write(path: string, content: string): void {
    this.mkdir(dirname(path));
    const before = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
    writeFileSync(path, content);
    this.steps.push(() => {
      if (before === undefined) rmSync(path, { force: true });
      else writeFileSync(path, before);
    });
  }

  /** Remembers a directory something else made (a migration's), to remove on undo. */
  created(path: string): void {
    this.steps.push(() => { rmSync(path, { recursive: true, force: true }); });
  }

  /** Puts back everything, newest first. */
  undo(): void {
    for (const step of this.steps.reverse()) {
      try {
        step();
      } catch {
        // Best effort: the rest still runs.
      }
    }
    this.steps.length = 0;
  }
}
