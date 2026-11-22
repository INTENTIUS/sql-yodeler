import { readFileSync } from "node:fs";
import type { ChantConfig } from "@intentius/chant";

/**
 * sql-yodeler's own config: the release (AGENTS.md, Releasing), on chant's
 * release block, the way terragucci releases (#319).
 *
 * .github/workflows/publish.yml is `chant release workflow`'s, started by hand
 * with the version (`gh workflow run publish.yml -f label=<version>`). The cut
 * releases the dispatched commit only when its checks on GitHub passed
 * (release.green "forge-checks"), builds the CI image as an OCI archive and
 * records its digest, builds and checks the package, and pushes the
 * v<version> tag, which `yodel create` takes a release's templates from. The
 * publish job pushes the image, publishes the package to npm with trusted
 * publishing (npm trusts publish.yml by its file name) and makes the GitHub
 * release from CHANGELOG.md's `## <version>` section. The after job installs
 * the release from npm and runs `yodel --version`, and runs it in the pushed
 * image.
 *
 * The label is the package version, which the release pull request sets in
 * package.json.
 */

const IMAGE = "ghcr.io/intentius/sql-yodeler";

/**
 * The CI image in each set (sql-yodeler issue 405): the Debian image, and the Chainguard one beside it in the same
 * repository under a tag ending -chainguard. src/ci/image-set.ts's releaseImages() names the same two, and
 * test/ci-image-base.test.ts checks they agree; this file stays free of src/ so chant loads it alone.
 */
const IMAGES = [
  { name: "sql-yodeler", dockerfile: ".github/image/Dockerfile", tag: "{label}" },
  { name: "sql-yodeler-chainguard", dockerfile: ".github/image-chainguard/Dockerfile", tag: "{label}-chainguard" },
] as const;

const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));

/** The package version, which is the release's label. */
const VERSION = (read("./package.json") as { version: string }).version;

/** The CI image's build context: the npm pack of the commit and nothing else. */
const IMAGE_CONTEXT = "dist/images/context";

/** The @intentius/chant packages yodel runs with, at package-lock.json's versions, installed in the image beside yodel. */
function chantPins(): string {
  const lock = read("./package-lock.json") as { packages: Record<string, { version: string; dev?: boolean }> };
  return Object.entries(lock.packages)
    .filter(([k, v]) => /^node_modules\/@intentius\/chant[^/]*$/.test(k) && !v.dev)
    .map(([k, v]) => `${k.slice("node_modules/".length)}@${v.version}`)
    .join(" ");
}

export default {
  lexicons: ["github"],
  // chant.workspace.json declares no members, so chant builds this root project alone.
  rootOnly: true,
  // What the cut compiles: this repository's workflows, and nothing else (without it the build would load every .ts here).
  sourceDir: ".github/chant",
  environments: ["release"],
  release: {
    // The tag yodel create takes a release's templates from (src/commands/create.ts). The 0.13 releases were also
    // tagged release/<version>, which chant still reads as earlier releases.
    tag: "v{version}",
    legacyTags: ["release/"],
    // A commit whose GitHub checks passed, the ruleset's required `check` among them.
    green: "forge-checks",
    workflow: {
      trigger: "dispatch",
      install: "npm ci",
      // The cut takes only a commit CI passed, so the cut and the publish build and check nothing more.
      build: "npm run build",
      chant: "npx chant",
      // chant adds packages: write and this run's token for the GHCR oci target, and npm 11.5.1 or later for
      // trusted publishing, from the targets (chant issue 4786), and QEMU for the image's arm64 half (chant issue 4876).
      after: [
        // The release as a user gets it: from the registry, into an empty directory, and run.
        `dir="$(mktemp -d)" && cd "$dir" && npm init -y >/dev/null && for attempt in $(seq 1 30); do npm install --prefer-online --no-audit --no-fund "@intentius/sql-yodeler@$CHANT_RELEASE_LABEL" && break; [ "$attempt" = 30 ] && exit 1; sleep 20; done && test "$(npx --no-install yodel --version)" = "$CHANT_RELEASE_LABEL"`,
        // Each image the publish pushed, run once, and its digest, which ci.image pins, for the Debian image and for the
        // Chainguard one (the package also carries both, for ci.imageBase).
        `for tag in "$CHANT_RELEASE_LABEL" "$CHANT_RELEASE_LABEL-chainguard"; do test "$(docker run --rm --pull always "${IMAGE}:$tag" yodel --version)" = "$CHANT_RELEASE_LABEL" && docker buildx imagetools inspect "${IMAGE}:$tag" --format '{{json .Manifest.Digest}}' | tr -d '"' | sed "s|^|${IMAGE}:$tag@|" | tee -a "$GITHUB_STEP_SUMMARY" || exit 1; done`,
      ],
      // npm's trusted publisher for this package names publish.yml.
      file: ".github/workflows/publish.yml",
    },
    images: IMAGES.map(({ name, dockerfile }) => ({
      name,
      dockerfile,
      // Each image installs yodel from npm pack of the commit being cut, not from npm, since the cut runs
      // before the publish. The context holds only the tarball, under dist/images, which the package leaves out.
      // The base images are pinned by digest (chant's pins for the Chainguard set), which supply-chain requires.
      prepare: `mkdir -p ${IMAGE_CONTEXT} && npm pack --silent --pack-destination ${IMAGE_CONTEXT} >/dev/null`,
      context: IMAGE_CONTEXT,
      archive: `dist/images/${name}.tar`,
      args: {
        YODEL_VERSION: VERSION,
        YODEL_PACKAGE: `/ctx/intentius-sql-yodeler-${VERSION}.tgz`,
        CHANT_PINS: chantPins(),
      },
    })),
    publish: [
      // Each image keeps the SBOM chant makes from its layers, which lists the OS packages, and is scanned, signed and
      // given provenance under supply-chain (chant.workspace.json).
      ...IMAGES.map(({ name, tag }) => ({ type: "oci" as const, image: `dist/images/${name}.tar`, repository: IMAGE, tags: [tag] })),
      // Trusted publishing may publish but not move a dist-tag, so straight to latest.
      // The package carries both images' digests (dist/image-digests.json, from scripts/image-digests.mjs) for ci.imageBase;
      // the publish plan refuses a digest the release did not build. It has no SBOM file of its own (one would differ
      // between the cut's pack and the publish's, and the images install that pack); chant scans it from the lockfile.
      { type: "npm" as const, packages: ["."], access: "public" as const, stage: false, sbom: false as const, pins: "dist/image-digests.json" },
      {
        type: "forge" as const,
        forge: "github" as const,
        repo: "INTENTIUS/sql-yodeler",
        assets: [],
        sbom: false as const,
        notes: {
          file: "CHANGELOG.md",
          heading: "## {version}",
          before: "`@intentius/sql-yodeler@{version}` on npm, and the CI images `ghcr.io/intentius/sql-yodeler:{version}` and `ghcr.io/intentius/sql-yodeler:{version}-chainguard`.",
          after: "[Release notes](https://intentius.io/sql-yodeler/release-notes/) lists every release.",
        },
      },
    ],
  },
} satisfies ChantConfig;
