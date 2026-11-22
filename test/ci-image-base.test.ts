/**
 * The CI image in two sets (sql-yodeler issue 405): the release builds and
 * publishes the Debian image and the Chainguard one, and yodel.config.ts
 * `ci.imageBase` picks the one `yodel ci` renders when `ci.image` is not set.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import config from "../chant.config.js";
import { checkYodelConfig } from "../src/config/load.js";
import { chantHasImageBase, committedImage, imageForBase, imageSetRefusal, imageTag, releaseImages, setImageDigestsForTests, IMAGE_REPOSITORY } from "../src/ci/image-set.js";
import { version } from "../src/version.js";
import { dockerfileOf } from "../.github/src/image.js";
import { render } from "../.github/src/render.js";
import { copyTemplate, repoRoot, yodel } from "./helpers/run.js";

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
afterEach(() => {
  setImageDigestsForTests("reset");
});

const DEBIAN = `sha256:${"a".repeat(64)}`;
const CHAINGUARD = `sha256:${"b".repeat(64)}`;

/** A release's digest table: both sets. */
const both = () => ({ [`${IMAGE_REPOSITORY}:${imageTag("debian")}`]: DEBIAN, [`${IMAGE_REPOSITORY}:${imageTag("chainguard")}`]: CHAINGUARD });

function project(ci: string): string {
  const dir = mkdtempSync(join(tmpdir(), "yodel-imagebase-"));
  temps.push(dir);
  copyTemplate("clickhouse", dir);
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  const file = join(dir, "yodel.config.ts");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^ {2}ci: .*$/m, `  ci: ${ci},`));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("the image sets", () => {
  it("name the Chainguard image beside the Debian one, in the same repository", () => {
    expect(imageTag("debian", "1.2.3")).toBe("1.2.3");
    expect(imageTag("chainguard", "1.2.3")).toBe("1.2.3-chainguard");
    expect(releaseImages().map((i) => [i.name, i.dockerfile, i.repository, i.tag("1.2.3")])).toEqual([
      ["sql-yodeler", ".github/image/Dockerfile", IMAGE_REPOSITORY, "1.2.3"],
      ["sql-yodeler-chainguard", ".github/image-chainguard/Dockerfile", IMAGE_REPOSITORY, "1.2.3-chainguard"],
    ]);
  });

  it("are what chant.config.ts builds and pushes, and the npm package pins the digests of both", () => {
    const images = config.release.images;
    expect(images.map((i) => [i.name, i.dockerfile, i.archive])).toEqual(releaseImages().map((i) => [i.name, i.dockerfile, `dist/images/${i.name}.tar`]));
    const oci = config.release.publish.filter((t) => t.type === "oci");
    expect(oci.map((t) => [t.image, t.repository, t.tags])).toEqual(
      releaseImages().map((i) => [`dist/images/${i.name}.tar`, i.repository, [i.tag("{label}")]]),
    );
    // The images keep the SBOM chant makes from their layers.
    for (const t of oci) expect(t).not.toHaveProperty("sbom");
    const npm = config.release.publish.find((t) => t.type === "npm");
    expect(npm).toMatchObject({ pins: "dist/image-digests.json" });
    // The images are scanned, signed and given provenance.
    const workspace = JSON.parse(readFileSync(join(repoRoot, "chant.workspace.json"), "utf8")) as { security?: string[] };
    expect(workspace.security).toContain("supply-chain");
  });
});

describe("the Dockerfiles", () => {
  it("are rendered for both sets, each FROM pinned by digest, the Chainguard one ending as a user that is not root", () => {
    const files = render();
    const debian = files.get(".github/image/Dockerfile") ?? "";
    expect(debian).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64}$/m);
    expect(debian).toContain("apt-get install");
    expect(debian).not.toMatch(/^USER 65532/m);
    const chainguard = files.get(".github/image-chainguard/Dockerfile") ?? "";
    expect(chainguard).toMatch(/^FROM cgr\.dev\/chainguard\/node:latest-dev@sha256:[0-9a-f]{64}$/m);
    // Packages come from apk under their Wolfi names, and the install steps run as root.
    const apkAdd = /^RUN apk add --no-cache ((?:[a-z][a-z0-9._+-]*=\S+ )+)\|\|/m.exec(chainguard);
    expect(apkAdd).not.toBeNull();
    const pinned = (apkAdd?.[1] ?? "").trim().split(" ");
    expect(pinned.map((p) => p.split("=")[0])).toEqual(["git", "ca-certificates", "openssh-client"]);
    for (const p of pinned) expect(p).toMatch(/^[^=]+=\S+-r\d+$/);
    expect(chainguard).not.toContain("apt-get");
    expect(chainguard.split("\n").filter((l) => l.startsWith("USER ")).at(-1)).toBe("USER 65532");
    expect(chainguard).toContain('LABEL io.intentius.chant.image.base="chainguard"');
    // Every FROM in either image is pinned: supply-chain refuses an unpinned one.
    for (const text of [debian, chainguard]) for (const from of text.match(/^FROM .*$/gm) ?? []) expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("install the same bundle and check the same version", () => {
    const body = (set: "debian" | "chainguard") => {
      const text = String(render().get(set === "debian" ? ".github/image/Dockerfile" : ".github/image-chainguard/Dockerfile"));
      return text.split("\n").filter((l) => l.startsWith("RUN --mount") || l.startsWith("ARG "));
    };
    expect(body("chainguard")).toEqual(body("debian"));
    expect(dockerfileOf("chainguard")).toBeDefined();
  });
});

describe("ci.imageBase", () => {
  it("is checked: debian or chainguard, and nothing else", () => {
    expect(checkYodelConfig({ ci: { imageBase: "chainguard" } }, "yodel.config.ts").ci).toEqual({ imageBase: "chainguard" });
    expect(checkYodelConfig({ ci: { imageBase: "debian" } }, "yodel.config.ts").ci).toEqual({ imageBase: "debian" });
    expect(() => checkYodelConfig({ ci: { imageBase: "alpine" } }, "yodel.config.ts")).toThrow(/ci\.imageBase: "debian" or "chainguard"/);
    expect(() => checkYodelConfig({ ci: { imageBase: true } }, "yodel.config.ts")).toThrow(/ci\.imageBase/);
  });

  it("refuses chainguard when the release's digest table has no Chainguard entry, unless ci.image names its own", () => {
    setImageDigestsForTests({ [`${IMAGE_REPOSITORY}:${imageTag("debian")}`]: DEBIAN });
    expect(imageSetRefusal("chainguard")).toMatch(/publishes no Chainguard images/);
    expect(() => imageForBase("chainguard")).toThrow(/publishes no Chainguard images/);
    expect(() => checkYodelConfig({ ci: { imageBase: "chainguard" } }, "yodel.config.ts")).toThrow(/ci\.imageBase: yodel .* publishes no Chainguard images/);
    expect(imageForBase("debian")).toBe(`${IMAGE_REPOSITORY}:${imageTag("debian")}@${DEBIAN}`);
    const own = `ghcr.io/example/own:1@sha256:${"c".repeat(64)}`;
    expect(checkYodelConfig({ ci: { imageBase: "chainguard", image: own } }, "yodel.config.ts").ci).toEqual({ imageBase: "chainguard", image: own });
  });

  it("names no digest where the build carries none, so a clone or the image's own yodel takes the committed one", () => {
    setImageDigestsForTests({});
    expect(imageSetRefusal("chainguard")).toBeUndefined();
    expect(imageForBase("chainguard")).toBeUndefined();
  });

  it("with no release digests, refuses to write an image no committed pipeline names, and checks the rest against the committed one", async () => {
    setImageDigestsForTests(both());
    const dir = project('{ imageBase: "chainguard" }');
    expect((await yodel(["ci", "--dir", dir])).code).toBe(0);
    const pr = join(dir, ".github/workflows/yodel-pr.yml");
    expect(committedImage(dir, "chainguard")).toBe(`${IMAGE_REPOSITORY}:${imageTag("chainguard")}@${CHAINGUARD}`);
    expect(committedImage(dir, "debian")).toBeUndefined();

    // The yodel inside the image: no table. The committed digest stands for the image, and the rest is compared.
    setImageDigestsForTests({});
    const checked = await yodel(["ci", "--check", "--dir", dir]);
    expect(checked.code, checked.err).toBe(0);
    writeFileSync(pr, readFileSync(pr, "utf8").replace("yodel lint", "yodel lint --edited"));
    const stale = await yodel(["ci", "--check", "--dir", dir]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("yodel-pr.yml");

    // A project with nothing committed has no digest to take.
    const fresh = project('{ imageBase: "chainguard" }');
    const refused = await yodel(["ci", "--dir", fresh]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/ci\.imageBase: "chainguard" names the release's chainguard image by its digest, and this yodel carries no release digests/);
  });

  it("with chainguard, renders every job in the Chainguard image by its digest, and with debian in the Debian one", async () => {
    setImageDigestsForTests(both());
    for (const [set, digest] of [["chainguard", CHAINGUARD], ["debian", DEBIAN]] as const) {
      const dir = project(`{ imageBase: "${set}" }`);
      const wrote = await yodel(["ci", "--dir", dir]);
      expect(wrote.code, wrote.err).toBe(0);
      const image = `${IMAGE_REPOSITORY}:${imageTag(set)}@${digest}`;
      for (const f of [".github/workflows/yodel-pr.yml", ".github/workflows/yodel-apply.yml", ".github/workflows/watch-dev.yml"]) {
        const text = readFileSync(join(dir, f), "utf8");
        expect(text, f).toContain(image);
        expect(text, f).not.toContain("npm ci");
        expect(text, f).not.toContain("node:22-bookworm");
        const doc = parseYAMLDocument(text) as { jobs: Record<string, { container?: unknown }> };
        for (const [name, job] of Object.entries(doc.jobs)) expect(job.container, `${f} ${name}`).toBe(image);
      }
      expect(readFileSync(join(dir, ".gitlab/yodel-plan.gitlab-ci.yml"), "utf8")).toContain(image);
      expect(readFileSync(join(dir, ".forgejo/workflows/yodel-pr.yml"), "utf8")).toContain(image);
    }
  });

  it("with ci.image set, that image wins over the pick", async () => {
    setImageDigestsForTests(both());
    const own = `ghcr.io/intentius/sql-yodeler:0.3.0@sha256:${"d".repeat(64)}`;
    const dir = project(`{ imageBase: "chainguard", image: "${own}" }`);
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const text = readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8");
    expect(text).toContain(own);
    expect(text).not.toContain(CHAINGUARD);
  });

  it("without the key, renders as before: node:22-bookworm and npm ci", async () => {
    setImageDigestsForTests(both());
    const dir = project("{}");
    const wrote = await yodel(["ci", "--dir", dir]);
    expect(wrote.code, wrote.err).toBe(0);
    const text = readFileSync(join(dir, ".github/workflows/yodel-pr.yml"), "utf8");
    expect(text).toContain("node:22-bookworm");
    expect(text).toContain("npm ci");
    expect(text).not.toContain(IMAGE_REPOSITORY);
  });
});

it("this chant takes base for CI images, so the Chainguard Dockerfile is rendered", () => {
  expect(chantHasImageBase()).toBe(true);
  expect(version()).toMatch(/^\d+\.\d+\.\d+/);
});
