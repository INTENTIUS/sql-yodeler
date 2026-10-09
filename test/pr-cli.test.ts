import { describe, expect, it } from "vitest";
import { fixture, yodel } from "./helpers/run.js";

describe("yodel plan's versioned flags", () => {
  it("refuses them on a declarative project, which keeps #6's plan", async () => {
    const ran = await yodel(["plan", "e2e", "--comment", "--dir", fixture("clickhouse")]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("--comment is for versioned migrations");
    const md = await yodel(["plan", "e2e", "--format", "markdown", "--dir", fixture("clickhouse")]);
    expect(md.err).toContain("--format markdown is for versioned migrations");
  });

  it("takes the forge flags only with --comment, and one format", async () => {
    expect((await yodel(["plan", "e2e", "--forge", "github"])).err).toContain("--forge goes with --comment");
    expect((await yodel(["plan", "e2e", "--json", "--format", "markdown"])).err).toContain("--json and --format markdown cannot be combined");
    expect((await yodel(["plan", "e2e", "--format", "html"])).err).toContain("--format must be text, markdown or json");
  });

  it("documents --comment and the forges in --help", async () => {
    const ran = await yodel(["plan", "--help"]);
    expect(ran.out).toMatch(/--comment[\s\S]*GitHub Actions,[\s\S]*GitLab CI, Forgejo Actions/);
  });
});
