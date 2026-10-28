/**
 * The overlays a yodel scenario's steps name (INTENTIUS/sql-yodeler#302).
 *
 * chant's driver writes an overlay's files over main and pushes them as the
 * pull request's branch, and asks for them synchronously. A yodel change is
 * a schema edit plus the migration `yodel new` writes for it, so each
 * overlay is made ahead, when an arm starts: in a clone of the base, the
 * change is made and `yodel new` run, and the files that differ are the
 * overlay. The overlays are made in the order the scenario merges them,
 * each on top of the ones before, so a later pull request's migration
 * follows the one main has by then.
 *
 * - add-note: a note column on the template's events table, and its migration.
 * - fork: the newest migration copied as `<id>-again`, a second migration
 *   with the same parent, its checksum recorded (lint fails it as a fork).
 * - loosen-gate: dev's wave gate set to never in yodel.config.ts, and an
 *   audit column with its migration.
 * - drop-note: the note column dropped, and its migration.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dialect } from "../lib/claim.js";
import { run } from "../lib/exec.js";

export type OverlayName = "add-note" | "fork" | "loosen-gate" | "drop-note";

const OVERLAYS: readonly string[] = ["add-note", "fork", "loosen-gate", "drop-note"];

export const isOverlay = (name: string): name is OverlayName => OVERLAYS.includes(name);

/** Where a change is made: a checkout of the project, with the environment yodel needs there. */
export interface Checkout {
  dir: string;
  dialect: Dialect;
  env: NodeJS.ProcessEnv;
}

async function sh(c: Checkout, cmd: string, args: string[], ok: (code: number) => boolean = (code) => code === 0): Promise<string> {
  const ran = await run(cmd, args, { cwd: c.dir, env: c.env, timeoutMs: 300_000 });
  if (!ok(ran.code)) throw new Error(`${cmd} ${args.join(" ")} exited ${String(ran.code)} in ${c.dir}: ${ran.err.slice(-400)}`);
  return ran.out;
}

/** The template's schema with `column` added to its table, or removed. */
export function editColumn(schema: string, dialect: Dialect, column: string, how: "add" | "drop"): string {
  if (how === "add") {
    const next = schema.replace(/\n {2}\)(\n|`)/, `,\n    ${column} ${dialect === "ch" ? "String DEFAULT ''" : "text"}\n  )$1`);
    if (next === schema) throw new Error(`could not add ${column} to the template's schema`);
    return next;
  }
  // A column with another after it ends in a comma; the last one has the comma before it.
  const middle = new RegExp(`\\n {4}${column} [^\\n]*,(?=\\n)`);
  const last = new RegExp(`,\\n {4}${column} [^\\n]*(?=\\n {2}\\))`);
  const next = middle.test(schema) ? schema.replace(middle, "") : schema.replace(last, "");
  if (next === schema) throw new Error(`the template's schema has no ${column} column to drop`);
  return next;
}

/** yodel.config.ts with `env`'s wave gate set to `gate`. */
export function setGate(config: string, env: string, gate: "always" | "on-destructive" | "never"): string {
  const next = config.replace(new RegExp(`(\\{ env: "${env}", gate: )"[a-z-]+"`), `$1"${gate}"`);
  if (next === config) throw new Error(`yodel.config.ts has no wave for ${env}`);
  return next;
}

/** Makes `name`'s change in the checkout, uncommitted. */
export async function makeChange(c: Checkout, name: OverlayName): Promise<void> {
  const schemaPath = join(c.dir, "src", "schema.ts");
  const configPath = join(c.dir, "yodel.config.ts");
  switch (name) {
    case "add-note":
      writeFileSync(schemaPath, editColumn(readFileSync(schemaPath, "utf8"), c.dialect, "note", "add"));
      await sh(c, "npx", ["yodel", "new", "add-note"]);
      return;
    case "loosen-gate":
      writeFileSync(configPath, setGate(readFileSync(configPath, "utf8"), "dev", "never"));
      writeFileSync(schemaPath, editColumn(readFileSync(schemaPath, "utf8"), c.dialect, "audit", "add"));
      await sh(c, "npx", ["yodel", "new", "add-audit"]);
      return;
    case "drop-note":
      writeFileSync(schemaPath, editColumn(readFileSync(schemaPath, "utf8"), c.dialect, "note", "drop"));
      await sh(c, "npx", ["yodel", "new", "drop-note"]);
      return;
    case "fork": {
      const migrations = join(c.dir, "migrations");
      const newest = readdirSync(migrations).filter((f) => existsSync(join(migrations, f, "migration.json"))).sort().at(-1);
      if (!newest) throw new Error("the project has no migration to fork");
      const forked = `${newest}-again`;
      mkdirSync(join(migrations, forked));
      for (const f of readdirSync(join(migrations, newest))) copyFileSync(join(migrations, newest, f), join(migrations, forked, f));
      const json = join(migrations, forked, "migration.json");
      const doc = readFileSync(json, "utf8");
      if (!doc.includes(`"id": "${newest}"`)) throw new Error(`${newest}'s migration.json does not record its id`);
      writeFileSync(json, doc.replace(`"id": "${newest}"`, `"id": "${forked}"`));
      // Its checksum recorded, so the fork is the only finding; lint exits non-zero on the fork all the same.
      await sh(c, "npx", ["yodel", "lint", "--update-checksum", forked], () => true);
      return;
    }
  }
}

/** The files the working tree changed or added since HEAD, repo-relative, with their content. */
async function changedFiles(c: Checkout): Promise<Record<string, string>> {
  const out = await sh(c, "git", ["status", "--porcelain", "--untracked-files=all"]);
  const files: Record<string, string> = {};
  for (const line of out.split("\n")) {
    if (line.length < 4 || line.startsWith(" D") || line.startsWith("D ")) continue;
    const path = line.slice(3).replace(/^.* -> /, "");
    // The clone's node_modules is a link to the base's, which a .gitignore of node_modules/ does not match.
    if (path === "node_modules" || path.startsWith("node_modules/")) continue;
    files[path] = readFileSync(join(c.dir, path), "utf8");
  }
  return files;
}

/**
 * The overlays `names` in a clone of the base at `base` (a git checkout of
 * the project, at main): each change made, its files read, then committed
 * in the clone so the next is made on top of it.
 */
export async function makeOverlays(base: Checkout, clone: string, names: readonly string[]): Promise<Map<string, Record<string, string>>> {
  await run("git", ["clone", "-q", base.dir, clone], { cwd: base.dir, timeoutMs: 120_000 });
  // node_modules is not in git: the clone uses the base's.
  const c: Checkout = { ...base, dir: clone, env: { ...base.env, PATH: `${join(base.dir, "node_modules", ".bin")}:${base.env.PATH ?? ""}` } };
  if (!existsSync(join(clone, "node_modules"))) symlinkSync(join(base.dir, "node_modules"), join(clone, "node_modules"));
  const out = new Map<string, Record<string, string>>();
  for (const name of names) {
    if (!isOverlay(name)) throw new Error(`${name} is not an overlay sql-yodeler's scenarios make (${OVERLAYS.join(", ")})`);
    await makeChange(c, name);
    const files = await changedFiles(c);
    if (Object.keys(files).length === 0) throw new Error(`the ${name} overlay changed nothing`);
    out.set(name, files);
    await sh(c, "git", ["add", "-A", "--", ".", ":!node_modules"]);
    await sh(c, "git", ["commit", "-qm", `overlay ${name}`]);
  }
  return out;
}
