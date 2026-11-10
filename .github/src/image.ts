/*
 * The CI image (#66): Node, yodel, chant and the sql lexicon, so a job needs
 * no `npm ci` to run yodel. Renders to .github/image/Dockerfile with
 * `npm run workflows`. A release's cut builds it from `npm pack` of the
 * commit it cuts (scripts/release-image.sh, chant.config.ts release.images),
 * and the publish pushes it to ghcr.io/intentius/sql-yodeler:<version>.
 *
 * The packages are installed in /opt/yodel, and /node_modules links to its
 * node_modules. Node looks for a bare import in every parent directory's
 * node_modules, so a project checked out anywhere in the container finds
 * @intentius/chant and @intentius/chant-lexicon-sql there: its
 * chant.config.ts and src/ build with no install of their own. A project
 * that does run `npm ci` uses its own copies instead.
 */

import type { ProductImageSpec } from "@intentius/chant/ci-image";

export const comment = `The CI image, ghcr.io/intentius/sql-yodeler:<version>: Node 22, yodel, chant
and the sql lexicon. A release's cut builds it from npm pack of the commit
(scripts/release-image.sh), and publish.yml pushes it with the npm release.

Build arguments:
  YODEL_VERSION  the version \`yodel --version\` must print, and the one
                 installed from npm unless YODEL_PACKAGE names another (required)
  YODEL_PACKAGE  what \`npm install\` installs, by default
                 @intentius/sql-yodeler@$YODEL_VERSION. The build context is
                 mounted at /ctx, so a tarball from \`npm pack\` in the
                 context installs as /ctx/<file>.tgz.
  CHANT_PINS     @intentius/chant packages at exact versions, installed
                 beside yodel so its chant ranges resolve to them (ci.yml
                 and scripts/release-image.sh pass package-lock.json's)

  docker build -f .github/image/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image`;

export const IMAGE_REPOSITORY = "ghcr.io/intentius/sql-yodeler";

const PREFIX = "/opt/yodel";

/**
 * chant's product image (#4784, `productImageStages`): chant's pinned
 * node:22-bookworm-slim, git, CA certificates and `safe.directory '*'`,
 * USER and HOME=/tmp for a job run as a uid with no passwd entry, no Node
 * compile cache or npm debug logs (a rebuild gives the same archive), then
 * yodel's npm bundle in /opt/yodel with /node_modules linked to it, and the
 * OCI labels. ./render.ts writes it with chant's `productImageDockerfile`.
 */
export const spec: ProductImageSpec = {
  name: "sql-yodeler",
  product: "yodel",
  description: "yodel, chant and the sql lexicon on Node 22, for CI jobs",
  source: "https://github.com/INTENTIUS/sql-yodeler",
  versionArg: "YODEL_VERSION",
  args: ["YODEL_PACKAGE", "CHANT_PINS"],
  // A sealed wave (#48) verifies seals with ssh-keygen.
  packages: ["openssh-client"],
  bundle: {
    npm: '"${YODEL_PACKAGE:-@intentius/sql-yodeler@$YODEL_VERSION}" $CHANT_PINS',
    prefix: PREFIX,
    mountContext: true,
    require: ["YODEL_VERSION"],
    // The image holds the version it is tagged with, or the build fails.
    check: ['test "$(yodel --version)" = "$YODEL_VERSION"', "chant --version"],
  },
};
