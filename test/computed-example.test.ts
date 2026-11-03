/**
 * examples/computed (#309): a schema computed from a list, through a
 * composite, and from a build parameter. The build needs no server. The
 * files docs/schema.md quotes ("Computing the schema") must be the
 * example's own, and the example must build what the page says.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChant } from "../src/chant/process.js";
import { repoRoot } from "./helpers/run.js";

const example = join(repoRoot, "examples", "computed");

interface Built {
  exports: string[];
  ddl: Record<string, string>;
}

async function build(params: string[] = []): Promise<Built> {
  const dir = mkdtempSync(join(tmpdir(), "yodel-computed-"));
  try {
    for (const f of ["chant.config.ts", "package.json", "src", "lib"]) cpSync(join(example, f), join(dir, f), { recursive: true });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    const out = join(dir, "schema.json");
    const ran = await runChant(["build", "src", "--lexicon", "sql", ...params.flatMap((p) => ["--param", p]), "-o", out], { cwd: dir });
    expect(ran.code, ran.stderr || ran.stdout).toBe(0);
    const { objects } = JSON.parse(readFileSync(out, "utf8")) as { objects: { export: string; ddl: string }[] };
    return { exports: objects.map((o) => o.export).sort(), ddl: Object.fromEntries(objects.map((o) => [o.export, o.ddl])) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("examples/computed: a schema computed from a list and a build parameter", () => {
  it("builds one partition and one index per region, each its own export", async () => {
    const b = await build();
    expect(b.exports).toEqual(["orders", "regionsIdx_apac", "regionsIdx_eu", "regionsIdx_us", "regionsPart_apac", "regionsPart_eu", "regionsPart_us", "shop"]);
    expect(b.ddl.regionsPart_eu).toBe("CREATE TABLE shop.orders_eu PARTITION OF shop.orders FOR VALUES IN ('eu')");
    expect(b.ddl.regionsIdx_apac).toBe("CREATE INDEX orders_apac_at_idx ON shop.orders_apac (at)");
  });

  it("takes the fillfactor from the tier parameter: 100 by default, 70 with --param tier=large", async () => {
    expect((await build()).ddl.orders).toContain("WITH (fillfactor = 100)");
    expect((await build(["tier=large"])).ddl.orders).toContain("WITH (fillfactor = 70)");
  });

  it("is what docs/schema.md quotes", () => {
    const page = readFileSync(join(repoRoot, "docs", "schema.md"), "utf8");
    for (const f of ["lib/regional.ts", "src/orders.ts"]) {
      expect(page, `docs/schema.md does not quote examples/computed/${f} as it is`).toContain(readFileSync(join(example, f), "utf8").trimEnd());
    }
  });
});
