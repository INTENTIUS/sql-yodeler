/*
 * The CI image (#66): Node, yodel, chant and the sql lexicon, so a job needs
 * no `npm ci` to run yodel. Renders to .github/image/Dockerfile (Debian) and
 * .github/image-chainguard/Dockerfile (Chainguard, sql-yodeler issue 405)
 * with `npm run workflows`. A release's cut builds each from `npm pack` of
 * the commit it cuts (the Dockerfile entries in chant.config.ts's
 * release.images), and the publish pushes them to
 * ghcr.io/intentius/sql-yodeler:<version> and <version>-chainguard.
 *
 * The packages are installed in /opt/yodel, and /node_modules links to its
 * node_modules. Node looks for a bare import in every parent directory's
 * node_modules, so a project checked out anywhere in the container finds
 * @intentius/chant and @intentius/chant-lexicon-sql there: its
 * chant.config.ts and src/ build with no install of their own. A project
 * that does run `npm ci` uses its own copies instead.
 */

import { productImageStages, type ProductImageSpec } from "@intentius/chant/ci-image";
import { Dockerfile } from "@intentius/chant-lexicon-docker";
import { requireImageBase, type ImageSet } from "../../src/ci/image-set.js";

const BUILD_ARGS = `Build arguments:
  YODEL_VERSION  the version \`yodel --version\` must print, and the one
                 installed from npm unless YODEL_PACKAGE names another (required)
  YODEL_PACKAGE  what \`npm install\` installs, by default
                 @intentius/sql-yodeler@$YODEL_VERSION. The build context is
                 mounted at /ctx, so a tarball from \`npm pack\` in the
                 context installs as /ctx/<file>.tgz.
  CHANT_PINS     @intentius/chant packages at exact versions, installed
                 beside yodel so its chant ranges resolve to them (ci.yml
                 and chant.config.ts pass package-lock.json's)`;

/** The Dockerfile's comment, per set. */
export const comment = (set: ImageSet = "debian"): string =>
  set === "chainguard"
    ? `The CI image's Chainguard set, ghcr.io/intentius/sql-yodeler:<version>-chainguard:
Chainguard's node image (Node 26 on its pinned digest, not the Node 22 of the
Debian image), yodel, chant and the sql lexicon, ending as user 65532. A
release's cut builds it from npm pack of the commit (chant.config.ts,
release.images), and publish.yml pushes it with the npm release.

${BUILD_ARGS}

  docker build -f .github/image-chainguard/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image-chainguard`
    : `The CI image, ghcr.io/intentius/sql-yodeler:<version>: Node 22, yodel, chant
and the sql lexicon. A release's cut builds it from npm pack of the commit
(chant.config.ts, release.images), and publish.yml pushes it with the npm release.

${BUILD_ARGS}

  docker build -f .github/image/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image`;

export const IMAGE_REPOSITORY = "ghcr.io/intentius/sql-yodeler";

const PREFIX = "/opt/yodel";

/**
 * chant's product image (#4784, `productImageStages`): chant's pinned
 * node:22-bookworm-slim, git, CA certificates and `safe.directory '*'`,
 * USER and HOME=/tmp for a job run as a uid with no passwd entry, no Node
 * compile cache or npm debug logs (a rebuild gives the same archive), then
 * yodel's npm bundle in /opt/yodel with /node_modules linked to it, and the
 * OCI labels. With `set` "chainguard" (chant's `base: "chainguard"`) the
 * bases are Chainguard's node and wolfi-base by digest, packages come from
 * apk, and the image ends as user 65532. `dockerfile` below declares it with
 * the docker lexicon, and ./render.ts writes it with the lexicon's
 * serializer.
 */
export function imageSpec(set: ImageSet = "debian"): ProductImageSpec {
  const chainguard = set === "chainguard";
  if (chainguard) requireImageBase("yodel's Chainguard image");
  return {
    name: "sql-yodeler",
    product: "yodel",
    description: chainguard ? "yodel, chant and the sql lexicon on Chainguard's node image, for CI jobs" : "yodel, chant and the sql lexicon on Node 22, for CI jobs",
    source: "https://github.com/INTENTIUS/sql-yodeler",
    // Only on the Chainguard set: a chant with no `base` refuses above rather than rendering Debian.
    ...(chainguard ? { base: "chainguard" as const } : {}),
    versionArg: "YODEL_VERSION",
    args: ["YODEL_PACKAGE", "CHANT_PINS"],
    // A sealed wave (#48) verifies seals with ssh-keygen. Debian's name; chant maps it to Wolfi's.
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
}

/** The Debian image's spec. */
export const spec: ProductImageSpec = imageSpec("debian");

/** The CI image of `set` as the docker lexicon's Dockerfile, from chant's product image stages. */
export const dockerfileOf = (set: ImageSet = "debian") => new Dockerfile({ stages: productImageStages(imageSpec(set)) });

/** The Debian image's Dockerfile. */
export const dockerfile = dockerfileOf("debian");
