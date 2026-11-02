/**
 * The object the declarative claim's adopt/unsupported part makes
 * (scenarios/lib/undeclarable.ts) is of a kind chant's sql lexicon still
 * refuses on Postgres, and yodel's refusal names it the way the part looks
 * for. The part used an operator, which chant declares now, so yodel init
 * --from adopted it and the part failed plain.
 */

import { describe, expect, it } from "vitest";
import { KIND_COVERAGE } from "@intentius/chant-lexicon-sql/coverage";
import { unsupportedRefusal } from "../src/init/adopt.js";
import { describeUnsupported } from "../src/init/unsupported.js";
import { UNSUPPORTED_KIND, unsupportedName, unsupportedObject, unsupportedSql } from "../scenarios/lib/undeclarable.js";

const status = (kind: string) => KIND_COVERAGE.postgres.find((r) => r.kind === kind)?.status;

describe("the adopt claim's undeclarable object", () => {
  it("is of a kind chant's coverage table refuses on Postgres, unlike the operator it was", () => {
    expect(status(UNSUPPORTED_KIND)).toBe("refused");
    expect(status("operator")).toBe("declared");
  });

  it("is named in yodel init --from's refusal as the part looks for it", () => {
    expect(describeUnsupported(unsupportedObject("yodel_34_declarative"))).toBe(unsupportedName("yodel_34_declarative"));
    const refusal = unsupportedRefusal("declarative", [describeUnsupported(unsupportedObject("yodel_34_declarative"))], false);
    expect(refusal?.exitCode).toBe(1);
    expect(refusal?.message).toContain(`  ${unsupportedName("yodel_34_declarative")}\n`);
  });

  it("is made in the claim's schema", () => {
    expect(unsupportedSql("s")).toBe("CREATE CONVERSION s.latin1_utf8 FOR 'LATIN1' TO 'UTF8' FROM iso8859_1_to_utf8");
  });
});
