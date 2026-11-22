/**
 * The two CI image sets a release publishes (sql-yodeler issue 405).
 *
 * `debian` is `node:22-bookworm-slim` with root as its user; `chainguard` is
 * Chainguard's `node` and `wolfi-base` images (chant's `base: "chainguard"`),
 * which carry a newer Node and end as user 65532. Both go to
 * ghcr.io/intentius/sql-yodeler, the Chainguard set under a tag ending
 * `-chainguard`: `<version>` and `<version>-chainguard`.
 *
 * A release's package build records both digests in dist/image-digests.json
 * (scripts/image-digests.mjs, from the cut's digests file), and
 * yodel.config.ts `ci.imageBase` picks the set `yodel ci` names. A build with
 * no such file (a clone, and the yodel inside the CI image, whose digest
 * cannot be in itself) takes the digest the project's committed pipelines
 * already carry, so `yodel ci --check` can compare the rest of the files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ciImage from "@intentius/chant/ci-image";
import { version } from "../version.js";

/** The image sets, Debian first. */
export type ImageSet = "debian" | "chainguard";
export const IMAGE_SETS: readonly ImageSet[] = ["debian", "chainguard"];

export const IMAGE_REPOSITORY = "ghcr.io/intentius/sql-yodeler";

/** The tag suffix of the Chainguard set. */
export const CHAINGUARD_TAG_SUFFIX = "-chainguard";

/**
 * Whether the installed chant takes `base` on `ProductImageSpec`: its
 * `CI_IMAGE_BASE_FLOOR` is exported. An older chant renders a product image
 * as Debian whatever `base` says, so anything that needs the Chainguard set
 * refuses there, by {@link requireImageBase}.
 */
export function chantHasImageBase(): boolean {
  return "CI_IMAGE_BASE_FLOOR" in ciImage;
}

/** Refuse, naming `what`, when the installed chant has no `base` for a product image. */
export function requireImageBase(what: string): void {
  if (!chantHasImageBase()) {
    throw new Error(`${what} needs a chant whose CI images take base (CI_IMAGE_BASE_FLOOR in @intentius/chant/ci-image), and the installed chant has none; move the @intentius/chant pin to a release that has it`);
  }
}

/** The tag of `set` at `v`: the version, with `-chainguard` on the Chainguard set's. */
export function imageTag(set: ImageSet, v: string = version()): string {
  return set === "chainguard" ? `${v}${CHAINGUARD_TAG_SUFFIX}` : v;
}

/** A release's digest table: each image reference (`ghcr.io/intentius/sql-yodeler:0.15.0`) to its digest. */
export type DigestTable = Record<string, string>;

const FILE = new URL("../image-digests.json", import.meta.url);

/** The table this build carries: dist/image-digests.json, which a release's build writes. Empty for any other build. */
function loadTable(): DigestTable {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as DigestTable;
  } catch {
    return {};
  }
}

let active: DigestTable | undefined;
const table = (): DigestTable => (active ??= loadTable());

/** Tests stand in a release's digest table. `reset` goes back to the one the build carries. */
export function setImageDigestsForTests(next: DigestTable | "reset"): void {
  active = next === "reset" ? undefined : next;
}

/** The image reference `set` has at this version, by digest when the table has it. */
export function publishedImageFor(set: ImageSet): { repository: string; tag: string; digest?: string } {
  const tag = imageTag(set);
  const digest = table()[`${IMAGE_REPOSITORY}:${tag}`];
  return { repository: IMAGE_REPOSITORY, tag, ...(digest ? { digest } : {}) };
}

/**
 * What stops a pick of `set` when this build carries a release's digests but
 * none for that set: a release that predates the Chainguard images. A build
 * with no digests at all names no image for either set, so nothing stops it.
 */
export function imageSetRefusal(set: ImageSet): string | undefined {
  if (set !== "chainguard") return undefined;
  const keys = Object.keys(table());
  if (keys.length === 0 || keys.some((k) => k.endsWith(CHAINGUARD_TAG_SUFFIX))) return undefined;
  return `yodel ${version()} publishes no Chainguard images, so its digest table has none to name; use a release that does, or name your own image in ci.image`;
}

/**
 * The image `ci.imageBase` names, as `<repository>:<tag>@<digest>`, or
 * undefined when this build's table has no digest for it. Throws the
 * {@link imageSetRefusal} for a table that has none for the Chainguard set.
 */
export function imageForBase(set: ImageSet): string | undefined {
  const refusal = imageSetRefusal(set);
  if (refusal) throw new Error(refusal);
  const ref = publishedImageFor(set);
  return ref.digest ? `${ref.repository}:${ref.tag}@${ref.digest}` : undefined;
}

/** One image a release builds and publishes: its name in chant's release.images and digests file, its Dockerfile and its tag. */
export interface ReleaseImage {
  name: string;
  set: ImageSet;
  /** From the repository root. */
  dockerfile: string;
  repository: string;
  /** The tag at `v` (`{label}` in the release declaration). */
  tag(v?: string): string;
}

/** The images a release builds: the Debian image, then the Chainguard one. */
export function releaseImages(): ReleaseImage[] {
  return IMAGE_SETS.map((set) => ({
    name: set === "chainguard" ? `sql-yodeler${CHAINGUARD_TAG_SUFFIX}` : "sql-yodeler",
    set,
    dockerfile: set === "chainguard" ? ".github/image-chainguard/Dockerfile" : ".github/image/Dockerfile",
    repository: IMAGE_REPOSITORY,
    tag: (v?: string) => imageTag(set, v),
  }));
}

/** Where a project's committed pipelines name their image: the pull request pipeline of each forge. */
const PIPELINE_FILES = [".github/workflows/yodel-pr.yml", ".forgejo/workflows/yodel-pr.yml", ".gitlab-ci.yml"];

/**
 * The digest of `set`'s image at this version that the project's committed
 * pipelines already name, for a yodel that carries no release digests (a
 * clone, or the yodel inside the CI image, which runs `yodel ci --check` in
 * a job). It lets the check compare everything else in the files; the digest
 * itself is the release's, and a yodel from the registry writes it.
 */
export function committedImage(dir: string, set: ImageSet): string | undefined {
  const ref = new RegExp(`${`${IMAGE_REPOSITORY}:${imageTag(set)}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[0-9a-f]{64}`);
  for (const file of PIPELINE_FILES) {
    try {
      const found = ref.exec(readFileSync(join(dir, file), "utf8"));
      if (found) return found[0];
    } catch {
      // not rendered for this forge
    }
  }
  return undefined;
}
