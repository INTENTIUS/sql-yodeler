import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, projectFrom, yodel } from "./helpers/run.js";

describe("yodel plan's versioned flags", () => {
  it("takes --pr-note on a declarative project (#249), and refuses --allow-out-of-order there", async () => {
    // --pr-note reads the pull request chant's plan job names first, before it reads the server.
    const was = process.env.PR_NUMBER;
    delete process.env.PR_NUMBER;
    try {
      const ran = await yodel(["plan", "e2e", "--pr-note", ".chant/pr", "--dir", fixture("clickhouse")]);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain("PR_NUMBER is not set to one; chant's plan job sets it");
    } finally {
      if (was !== undefined) process.env.PR_NUMBER = was;
    }
    const late = await yodel(["plan", "e2e", "--allow-out-of-order", "--dir", fixture("clickhouse")]);
    expect(late.code).toBe(1);
    expect(late.err).toContain("--allow-out-of-order is for versioned migrations");
    expect(late.err).toContain("docs/workflows.md");
  });

  it("refuses --part on a declarative project (#237): it writes a versioned plan", async () => {
    const ran = await yodel(["plan", "e2e", "--part", "part.json", "--dir", fixture("clickhouse")]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("--part is for versioned migrations");
  });

  it("takes no forge flags, the note job's (sql-yodeler issue 345), and one format", async () => {
    expect((await yodel(["plan", "e2e", "--comment"])).err).toContain("Unknown option '--comment'");
    expect((await yodel(["plan", "e2e", "--json", "--format", "markdown"])).err).toContain("--json and --format markdown cannot be combined");
    expect((await yodel(["plan", "e2e", "--format", "html"])).err).toContain("--format must be text, markdown or json");
  });

  it("documents --pr-note and chant's note job in --help", async () => {
    const ran = await yodel(["plan", "--help"]);
    expect(ran.out).toMatch(/--pr-note <dir>[\s\S]*pr-plan-note\.json[\s\S]*chant's note job/);
  });
});

describe("yodel plan <env>/@<i>of<n>, the target chant's sql-migrate passes for a slot (#56)", () => {
  const withTenants = (tenants: string) => {
    const p = projectFrom("postgres-versioned");
    writeFileSync(join(p.dir, "yodel.config.ts"), `export default { environments: { e2e: { tenants: ${tenants} } }, waves: [{ env: "e2e", gate: "always", shares: 2 }] };\n`);
    return p;
  };

  it("takes the slot as a slot, not as a tenant named @1of2", async () => {
    const p = withTenants(`{ query: "SELECT name FROM tenants" }`);
    try {
      const ran = await yodel(["plan", "e2e/@1of2", "--part", join(p.dir, "part.json"), "--dir", p.dir]);
      expect(ran.err).not.toContain("is not a tenant name");
      // The fixture has no migrations, so the slot stops there, before any server is read.
      expect(ran.code).toBe(1);
      expect(ran.err).toContain("e2e/@1of2 is a slot of a tenant set's wave, for versioned migrations");
    } finally {
      p.dispose();
    }
  });

  it("refuses a slot of a set that is not read by a query, which the pipeline runs a tenant at a time", async () => {
    const p = withTenants(`["acme", "globex"]`);
    try {
      const ran = await yodel(["plan", "e2e/@1of2", "--part", join(p.dir, "part.json"), "--dir", p.dir]);
      expect(ran.code).toBe(1);
      expect(ran.err).toContain("e2e's tenant set is not read by a query");
      expect(ran.err).toContain("yodel plan e2e/<tenant>");
    } finally {
      p.dispose();
    }
  });
});
