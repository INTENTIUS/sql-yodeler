/**
 * src/init/unsupported.ts (#251): objects chant's sql lexicon cannot declare,
 * as chant's coverage table names them, and the refusal `yodel init --from`
 * makes on them.
 */

import { describe, expect, it } from "vitest";
import { unsupportedRefusal } from "../src/init/adopt.js";
import { baselineRow } from "../src/init/baseline.js";
import { KIND_COVERAGE } from "@intentius/chant-lexicon-sql/coverage";
import { describeUnsupported } from "../src/init/unsupported.js";
import { renderDrift } from "../src/chant/drift.js";

describe("the kinds yodel refuses", () => {
  it("are the ones chant's coverage table refuses: composite types, aggregates and quotas adopt now, operators and foreign tables do not", () => {
    const status = (dialect: "postgres" | "clickhouse", kind: string) => KIND_COVERAGE[dialect].find((r) => r.kind === kind)?.status;
    for (const k of ["composite type", "range type", "aggregate", "collation", "cast", "event trigger"]) expect(status("postgres", k), k).toBe("declared");
    for (const k of ["operator", "foreign table", "publication"]) expect(status("postgres", k), k).toBe("refused");
    for (const k of ["quota", "settings profile"]) expect(status("clickhouse", k), k).toBe("declared");
    expect(status("clickhouse", "named collection")).toBe("refused");
  });

  it("are described as chant describes them, with the schema when there is one", () => {
    expect(describeUnsupported({ kind: "operator", schema: "shop", name: "===(integer,integer)" })).toBe("operator shop.===(integer,integer)");
    expect(describeUnsupported({ kind: "publication", name: "pub" })).toBe("publication pub");
  });
});

describe("yodel init --from", () => {
  const found = [describeUnsupported({ kind: "operator", schema: "shop", name: "===(integer,integer)" }), describeUnsupported({ kind: "foreign table", schema: "shop", name: "remote" })];

  it("refuses (exit 4) naming each object, and adopts with --skip-unsupported", () => {
    const refusal = unsupportedRefusal("prod", found, false);
    expect(refusal?.exitCode).toBe(4);
    expect(refusal?.message).toContain("prod holds 2 objects of a kind chant's sql lexicon cannot declare");
    expect(refusal?.message).toContain("  operator shop.===(integer,integer)\n  foreign table shop.remote");
    expect(refusal?.message).toContain("--skip-unsupported");
    expect(unsupportedRefusal("prod", found, true)).toBeUndefined();
    expect(unsupportedRefusal("prod", [], false)).toBeUndefined();
  });

  it("records what --skip-unsupported left out in the baseline's note", () => {
    const row = baselineRow({ id: "20261012T0000-baseline", parent: null, checksum: "sha256:x" }, { seq: 1, runId: "r", appliedBy: "a", environment: "prod", skipped: found });
    expect(row.note).toBe("baseline: adopted from the live database by yodel init --from prod; its statements were not run; not adopted, of kinds yodel cannot declare: operator shop.===(integer,integer), foreign table shop.remote");
  });
});

describe("yodel drift", () => {
  it("lists objects of kinds yodel cannot declare as unmanaged, apart from drift", () => {
    const text = renderDrift({ environment: "prod", changed: [], missing: [], unobserved: [], unmanaged: ["operator shop.===(integer,integer)"] });
    expect(text).toContain("No drift: every declared object matches the server.");
    expect(text).toContain("Unmanaged (a kind yodel cannot declare, so never drift):\n  operator shop.===(integer,integer)");
  });
});
