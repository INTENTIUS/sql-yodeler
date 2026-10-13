/**
 * `yodel new` keeps src/sql-types.d.ts up with the declarations (#273):
 * after a declaration change it runs `chant sql types` when the project
 * keeps the file, and leaves a project without one alone.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offline } from "./helpers/new-suite.js";
import { projectFrom, repoRoot, yodel } from "./helpers/run.js";

offline();

const addNote = (dir: string) => {
  const file = join(dir, "src", "schema.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace("amount numeric(12, 2) NOT NULL\n", "amount numeric(12, 2) NOT NULL,\n    note   text\n"));
};

describe("yodel new and src/sql-types.d.ts (#273)", () => {
  it("refreshes the file after a declaration change, and says so", async () => {
    const p = projectFrom("postgres");
    try {
      execFileSync(join(repoRoot, "node_modules", ".bin", "chant"), ["sql", "types", "--output", "src/sql-types.d.ts"], { cwd: p.dir, stdio: "ignore" });
      const types = join(p.dir, "src", "sql-types.d.ts");
      expect(readFileSync(types, "utf8")).not.toContain("note");
      expect((await yodel(["new", "init", "--dir", p.dir])).code).toBe(0);
      addNote(p.dir);
      const ran = await yodel(["new", "add-note", "--dir", p.dir]);
      expect(ran.code, ran.err).toBe(0);
      expect(ran.out).toContain("Updated src/sql-types.d.ts from the declarations.");
      expect(readFileSync(types, "utf8")).toContain("note");
    } finally {
      p.dispose();
    }
  }, 120_000);

  it("writes no file in a project that does not keep one", async () => {
    const p = projectFrom("postgres");
    try {
      addNote(p.dir);
      const ran = await yodel(["new", "init", "--dir", p.dir]);
      expect(ran.code, ran.err).toBe(0);
      expect(ran.out).not.toContain("sql-types");
      expect(existsSync(join(p.dir, "src", "sql-types.d.ts"))).toBe(false);
    } finally {
      p.dispose();
    }
  }, 120_000);
});
