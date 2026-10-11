/**
 * Binary files go in Git LFS (.gitattributes). A tracked file whose content
 * git sees as binary must be an LFS pointer, unless .gitattributes keeps it
 * a plain file by name (`-filter`): the brand images committed before LFS.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers/run.js";

const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });

/** Each tracked path and whether git sees its committed content as binary (`git ls-files --eol`). */
function tracked(): Array<{ path: string; binary: boolean }> {
  return git(["ls-files", "--eol", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { path: line.slice(tab + 1), binary: line.startsWith("i/-text") };
    });
}

/** The value of `attr` for each path, from .gitattributes. */
function attr(attr: string, paths: string[]): Map<string, string> {
  if (!paths.length) return new Map();
  const out = git(["check-attr", "-z", attr, "--", ...paths]).split("\0");
  const m = new Map<string, string>();
  for (let i = 0; i + 2 < out.length; i += 3) m.set(out[i] ?? "", out[i + 2] ?? "");
  return m;
}

describe("binary files", () => {
  it("are LFS pointers, or kept plain by name in .gitattributes", () => {
    const binaries = tracked()
      .filter((f) => f.binary)
      .map((f) => f.path);
    const filter = attr("filter", binaries);
    const kept = binaries.filter((p) => filter.get(p) === "unset");
    // A binary file in LFS is committed as a text pointer, so one seen as binary here was committed without LFS.
    expect(
      binaries.filter((p) => !kept.includes(p)),
      "binary files committed without Git LFS: install it (git lfs install), then git rm --cached and add them again",
    ).toEqual([]);
  });

  it("have an LFS line for every common binary type", () => {
    const types = ["png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "pdf", "woff", "woff2", "ttf", "otf", "zip", "gz", "tgz", "mp4", "webm", "mov", "sqlite", "parquet"];
    const filter = attr(
      "filter",
      types.map((t) => `any/new.${t}`),
    );
    expect(types.filter((t) => filter.get(`any/new.${t}`) !== "lfs")).toEqual([]);
  });

  it("kept plain are only the brand images committed before LFS", () => {
    const filter = attr(
      "filter",
      tracked().map((f) => f.path),
    );
    const kept = [...filter].filter(([, v]) => v === "unset").map(([p]) => p);
    // Add to LFS instead of to this list.
    expect(kept.sort()).toEqual([
      "docs-site/public/brand/hat-160.png",
      "docs-site/public/brand/hat-small.png",
      "docs-site/public/brand/hat-source.png",
      "docs-site/public/brand/hat.png",
      "docs-site/public/favicon-32.png",
      "docs-site/public/favicon.ico",
      "docs-site/public/hat-share.png",
      "docs-site/public/social-preview.png",
      "docs-site/src/assets/brand/hat.png",
    ]);
  });
});
