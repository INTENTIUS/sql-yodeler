import { describe, expect, it, vi } from "vitest";

// A chant that predates `base` for CI images: its ci-image exports no CI_IMAGE_BASE_FLOOR and would render every image as Debian.
vi.mock("@intentius/chant/ci-image", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(real).filter(([name]) => name !== "CI_IMAGE_BASE_FLOOR"));
});

const set = await import("../src/ci/image-set.js");
const image = await import("../.github/src/image.js");
const { render } = await import("../.github/src/render.js");

describe("on a chant with no base for CI images", () => {
  it("refuses the Chainguard image with a message that names the floor, rather than rendering it as Debian", () => {
    expect(set.chantHasImageBase()).toBe(false);
    expect(() => image.imageSpec("chainguard")).toThrow(/CI_IMAGE_BASE_FLOOR/);
    expect(() => image.dockerfileOf("chainguard")).toThrow(/Chainguard image/);
  });

  it("keeps the Debian image, and renders no Chainguard Dockerfile", () => {
    const files = render();
    expect(files.has(".github/image/Dockerfile")).toBe(true);
    expect(files.has(".github/image-chainguard/Dockerfile")).toBe(false);
  });
});
