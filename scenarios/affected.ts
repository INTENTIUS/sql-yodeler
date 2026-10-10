/**
 * The claims a change can affect, for `npm run claims -- --affected [base]`.
 *
 * The change is every path that differs between the merge base of `base`
 * and HEAD and the working tree, untracked files included, renames as both
 * their old and new path. Each path takes the first line of
 * scenarios/claim-paths.txt whose glob matches it; a path no line matches
 * picks every claim.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const claimPathsFile = fileURLToPath(new URL("./claim-paths.txt", import.meta.url));

/** One line of claim-paths.txt. */
export interface Entry {
  glob: string;
  /** "ALL", or the claims named; empty for "-". */
  claims: "ALL" | string[];
  line: number;
  re: RegExp;
}

/** `*` is any run but `/`, `**` any run, `?` one character but `/`; a trailing `/` is the whole directory. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g.charAt(i);
    if (ch === "*" && g.charAt(i + 1) === "*") {
      // "**/" also matches no directory at all.
      if (g.charAt(i + 2) === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Parses claim-paths.txt; throws on a line with a glob and nothing after it. */
export function parseClaimPaths(text: string): Entry[] {
  const entries: Entry[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const [glob = "", ...rest] = line.split(/\s+/);
    if (!rest.length) throw new Error(`claim-paths.txt:${String(i + 1)}: ${glob} names no claim; write - for none or ALL for every one`);
    const claims = rest.length === 1 && rest[0] === "ALL" ? "ALL" : rest.length === 1 && rest[0] === "-" ? [] : rest;
    if (claims !== "ALL" && (claims.includes("ALL") || claims.includes("-"))) throw new Error(`claim-paths.txt:${String(i + 1)}: ALL and - stand alone`);
    entries.push({ glob, claims, line: i + 1, re: globToRegExp(glob) });
  });
  return entries;
}

export function readClaimPaths(file = claimPathsFile): Entry[] {
  return parseClaimPaths(readFileSync(file, "utf8"));
}

/** The claim names the entries give that are not claims. */
export function unknownClaims(entries: Entry[], names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of entries) if (e.claims !== "ALL") for (const c of e.claims) if (!names.includes(c)) out.add(`${c} (claim-paths.txt:${String(e.line)})`);
  return [...out];
}

export function entryFor(path: string, entries: Entry[]): Entry | undefined {
  return entries.find((e) => e.re.test(path));
}

export interface Affected {
  /** The claims picked, in the order of `names`. */
  claims: string[];
  /** Per claim picked: the paths that picked it, each with the glob it matched ("no entry" when none did). */
  why: Map<string, string[]>;
  /** The paths that pick no claim, each with its glob. */
  inert: string[];
}

export function affected(paths: readonly string[], entries: Entry[], names: readonly string[]): Affected {
  const why = new Map<string, string[]>();
  const inert: string[] = [];
  const add = (claim: string, reason: string) => {
    const list = why.get(claim) ?? [];
    list.push(reason);
    why.set(claim, list);
  };
  for (const p of paths) {
    const e = entryFor(p, entries);
    if (!e) {
      for (const c of names) add(c, `${p} (no entry: every claim)`);
      continue;
    }
    const picked = e.claims === "ALL" ? names : e.claims;
    if (!picked.length) inert.push(`${p} (${e.glob})`);
    for (const c of picked) add(c, `${p} (${e.glob})`);
  }
  return { claims: names.filter((n) => why.has(n)), why, inert };
}

/** One line per claim picked, saying why; at most `max` paths each. */
export function reasons(a: Affected, max = 3): string[] {
  return a.claims.map((c) => {
    const list = a.why.get(c) ?? [];
    const more = list.length > max ? `, and ${String(list.length - max)} more` : "";
    return `${c}: ${list.slice(0, max).join(", ")}${more}`;
  });
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The merge base with `base` (short), and every path changed since it, sorted. */
export function changedSince(base: string, cwd: string): { mergeBase: string; paths: string[] } {
  const mb = git(cwd, ["merge-base", base, "HEAD"]).trim();
  const diff = git(cwd, ["diff", "--name-only", "--no-renames", mb]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const paths = [...new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean))].sort();
  return { mergeBase: git(cwd, ["rev-parse", "--short", mb]).trim(), paths };
}
