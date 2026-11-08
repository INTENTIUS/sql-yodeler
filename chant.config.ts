import type { ChantConfig } from "@intentius/chant";

/**
 * sql-yodeler's own config: the release (AGENTS.md, Releasing), on chant's
 * release block, the way terragucci releases (#319).
 *
 * .github/workflows/publish.yml is `chant release workflow`'s, started by hand
 * with the version (`gh workflow run publish.yml -f label=<version>`). The gate
 * names the newest green commit at or below the dispatched one (the ci/green
 * tags chant-ci-green.yml writes, from chant.workspace.json's ci.green). The
 * cut builds the CI image as an OCI archive and records its digest, builds and
 * checks the package, and pushes the release/<version> tag. The publish job
 * pushes the image, publishes the package to npm with trusted publishing (npm
 * trusts publish.yml by its file name) and makes the GitHub release from
 * CHANGELOG.md's `## <version>` section. The after job tags the commit
 * `v<version>` for `yodel create`, installs the release from npm and runs
 * `yodel --version`, and runs it in the pushed image.
 *
 * The label is the package version, which the release pull request sets in
 * package.json.
 */

/** npm trusted publishing needs npm 11.5.1 or later. */
const NPM_TRUSTED_PUBLISHING_MIN = "11.5.1";

const IMAGE = "ghcr.io/intentius/sql-yodeler";

export default {
  lexicons: ["github"],
  // chant.workspace.json declares no members; it is there for ci.green, so chant builds this root project alone.
  rootOnly: true,
  // What the cut compiles: this repository's workflows, and nothing else (without it the build would load every .ts here).
  sourceDir: ".github/chant",
  environments: ["release"],
  release: {
    workflow: {
      trigger: "dispatch",
      gate: "last-green",
      install: "npm ci",
      // The gate cut only a commit CI passed, so the cut and the publish build and check nothing more.
      build: "npm run build",
      chant: "npx chant",
      // GHCR: the oci target pushes with this run's token.
      permissions: { packages: "write" },
      env: { OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" },
      setup: [
        // QEMU, so an amd64 runner builds the arm64 half of the image.
        { uses: "docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0", with: { platforms: "arm64" } },
        { run: `have="$(npm --version)"; if [ "$(printf '%s\\n' "${NPM_TRUSTED_PUBLISHING_MIN}" "$have" | sort -V | head -n1)" != "${NPM_TRUSTED_PUBLISHING_MIN}" ]; then npm install -g npm@^${NPM_TRUSTED_PUBLISHING_MIN}; fi; npm --version` },
      ],
      after: [
        // The v<version> tag yodel create takes a release's templates from (src/commands/create.ts), on the commit the cut tagged.
        `git tag "v$CHANT_RELEASE_LABEL" && git push origin "refs/tags/v$CHANT_RELEASE_LABEL"`,
        // The release as a user gets it: from the registry, into an empty directory, and run.
        `dir="$(mktemp -d)" && cd "$dir" && npm init -y >/dev/null && for attempt in $(seq 1 30); do npm install --prefer-online --no-audit --no-fund "@intentius/sql-yodeler@$CHANT_RELEASE_LABEL" && break; [ "$attempt" = 30 ] && exit 1; sleep 20; done && test "$(npx --no-install yodel --version)" = "$CHANT_RELEASE_LABEL"`,
        // The image the publish pushed, and its digest for ci.image.
        `test "$(docker run --rm --pull always "${IMAGE}:$CHANT_RELEASE_LABEL" yodel --version)" = "$CHANT_RELEASE_LABEL" && docker buildx imagetools inspect "${IMAGE}:$CHANT_RELEASE_LABEL" --format '{{json .Manifest.Digest}}' | tr -d '"' | sed "s|^|${IMAGE}:$CHANT_RELEASE_LABEL@|" | tee -a "$GITHUB_STEP_SUMMARY"`,
      ],
      // npm's trusted publisher for this package names publish.yml.
      file: ".github/workflows/publish.yml",
    },
    images: [{ name: "sql-yodeler", build: "bash scripts/release-image.sh", archive: "dist/images/sql-yodeler.tar" }],
    publish: [
      // The image's SBOM is not the repository's lockfile, so none is attached; chant attaches the provenance.
      { type: "oci" as const, image: "dist/images/sql-yodeler.tar", repository: IMAGE, tags: ["{label}"], sbom: false as const },
      // Trusted publishing may publish but not move a dist-tag, so straight to latest.
      { type: "npm" as const, packages: ["."], access: "public" as const, stage: false, sbom: false as const },
      {
        type: "forge" as const,
        forge: "github" as const,
        repo: "INTENTIUS/sql-yodeler",
        assets: [],
        sbom: false as const,
        notes: {
          file: "CHANGELOG.md",
          heading: "## {version}",
          before: "`@intentius/sql-yodeler@{version}` on npm, and the CI image `ghcr.io/intentius/sql-yodeler:{version}`.",
          after: "[Release notes](https://intentius.io/sql-yodeler/release-notes/) lists every release.",
        },
      },
    ],
  },
} satisfies ChantConfig;
