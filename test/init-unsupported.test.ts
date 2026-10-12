/**
 * src/init/unsupported.ts (#251): the catalog queries for objects chant's sql
 * lexicon cannot declare, and the refusal `yodel init --from` makes on them.
 */

import { describe, expect, it } from "vitest";
import { unsupportedRefusal } from "../src/init/adopt.js";
import { baselineRow } from "../src/init/baseline.js";
import { CLICKHOUSE_ACCESS_KINDS, describeUnsupported, POSTGRES_KINDS } from "../src/init/unsupported.js";
import { renderDrift } from "../src/chant/drift.js";

describe("the Postgres kinds", () => {
  it("covers the schema-level and database-level kinds the lexicon cannot declare, each once", () => {
    const kinds = POSTGRES_KINDS.map((k) => k.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of ["composite type", "range type", "aggregate", "collation", "operator", "cast", "event trigger", "foreign table", "foreign server", "publication"]) expect(kinds).toContain(k);
  });

  it("reads the profile's schemas through $1, and leaves out what an extension owns or Postgres made with another object", () => {
    for (const k of POSTGRES_KINDS) {
      expect(k.sql.includes("$1"), k.kind).toBe(k.scoped);
      if (k.kind !== "subscription") expect(k.sql, k.kind).toContain("dep.deptype IN ('e', 'i')");
      expect(k.sql, k.kind).toMatch(/AS name\b/);
    }
  });

  it("reads composite types that are no table's row type, and casts above the server's own", () => {
    const composite = POSTGRES_KINDS.find((k) => k.kind === "composite type")?.sql ?? "";
    expect(composite).toContain("t.typtype = 'c'");
    expect(composite).toContain("c.relkind = 'c'");
    expect(POSTGRES_KINDS.find((k) => k.kind === "cast")?.sql).toContain("c.oid >= 16384");
  });
});

describe("the ClickHouse kinds", () => {
  it("reads settings profiles and quotas made with SQL, not the server's users.xml", () => {
    expect(CLICKHOUSE_ACCESS_KINDS.map((k) => k.kind)).toEqual(["settings profile", "quota"]);
    for (const k of CLICKHOUSE_ACCESS_KINDS) expect(k.sql).toContain("storage <> 'users_xml'");
  });
});

describe("yodel init --from", () => {
  const found = [describeUnsupported({ kind: "composite type", name: "shop.pair" }), describeUnsupported({ kind: "aggregate", name: "shop.total(integer)" })];

  it("refuses (exit 4) naming each object, and adopts with --skip-unsupported", () => {
    const refusal = unsupportedRefusal("prod", found, false);
    expect(refusal?.exitCode).toBe(4);
    expect(refusal?.message).toContain("prod holds 2 objects of a kind chant's sql lexicon cannot declare");
    expect(refusal?.message).toContain("  composite type shop.pair\n  aggregate shop.total(integer)");
    expect(refusal?.message).toContain("--skip-unsupported");
    expect(unsupportedRefusal("prod", found, true)).toBeUndefined();
    expect(unsupportedRefusal("prod", [], false)).toBeUndefined();
  });

  it("records what --skip-unsupported left out in the baseline's note", () => {
    const row = baselineRow({ id: "20261012T0000-baseline", parent: null, checksum: "sha256:x" }, { seq: 1, runId: "r", appliedBy: "a", environment: "prod", skipped: found });
    expect(row.note).toBe("baseline: adopted from the live database by yodel init --from prod; its statements were not run; not adopted, of kinds yodel cannot declare: composite type shop.pair, aggregate shop.total(integer)");
  });
});

describe("yodel drift", () => {
  it("lists objects of kinds yodel cannot declare as unmanaged, apart from drift", () => {
    const text = renderDrift({ environment: "prod", changed: [], missing: [], unobserved: [], unmanaged: ["range type shop.span"] });
    expect(text).toContain("No drift: every declared object matches the server.");
    expect(text).toContain("Unmanaged (a kind yodel cannot declare, so never drift):\n  range type shop.span");
  });
});
