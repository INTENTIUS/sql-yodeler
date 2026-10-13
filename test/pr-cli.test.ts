import { describe, expect, it } from "vitest";
import { fixture, yodel } from "./helpers/run.js";

describe("yodel plan's versioned flags", () => {
  it("takes --comment on a declarative project (#249), and refuses --allow-out-of-order there", async () => {
    // --comment resolves the forge first, before it reads the server.
    const ran = await yodel(["plan", "e2e", "--comment", "--forge", "github", "--repo", "o/r", "--pr", "1", "--api-url", "http://127.0.0.1:9", "--token-env", "YODEL_TEST_NO_SUCH_TOKEN", "--dir", fixture("clickhouse")]);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain("--comment on github needs a token");
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
