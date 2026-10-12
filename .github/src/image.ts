/*
 * The CI image (#66): Node, yodel, chant and the sql lexicon, so a job needs
 * no `npm ci` to run yodel. Renders to .github/image/Dockerfile with
 * `npm run workflows`, and publish.yml builds and pushes it to
 * ghcr.io/intentius/sql-yodeler:<version> after the npm release.
 *
 * The packages are installed in /opt/yodel, and /node_modules links to its
 * node_modules. Node looks for a bare import in every parent directory's
 * node_modules, so a project checked out anywhere in the container finds
 * @intentius/chant and @intentius/chant-lexicon-sql there: its
 * chant.config.ts and src/ build with no install of their own. A project
 * that does run `npm ci` uses its own copies instead.
 */

import { Dockerfile } from "@intentius/chant-lexicon-docker";

export const comment = `The CI image, ghcr.io/intentius/sql-yodeler:<version>: Node 22, yodel, chant
and the sql lexicon. publish.yml builds and pushes it after the npm release.

Build arguments:
  YODEL_VERSION  the version to install from npm, and the version
                 \`yodel --version\` must print (required)
  YODEL_PACKAGE  what \`npm install\` installs, by default
                 @intentius/sql-yodeler@$YODEL_VERSION. The build context is
                 mounted at /ctx, so a tarball from \`npm pack\` in the
                 context installs as /ctx/<file>.tgz.
  CHANT_PINS     @intentius/chant packages at exact versions, installed
                 beside yodel so its chant ranges resolve to them (ci.yml
                 and publish.yml pass package-lock.json's)

  docker build -f .github/image/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image`;

/** node:22-bookworm-slim by index digest (Node 22.23.3), so a rebuild cannot change underneath the tag. */
export const NODE_IMAGE = "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";

export const IMAGE_REPOSITORY = "ghcr.io/intentius/sql-yodeler";

const PREFIX = "/opt/yodel";

const install = [
  '--mount=type=bind,target=/ctx test -n "$YODEL_VERSION"',
  `mkdir -p ${PREFIX}`,
  `cd ${PREFIX}`,
  "echo '{\"name\":\"yodel-image\",\"private\":true}' > package.json",
  // npm lists a release before it serves its tarballs, so an install right
  // after a publish can answer E404 or ETARGET for a few minutes: three
  // tries, 45s apart, on those two errors only.
  '{ ok=; for try in 1 2 3; do if npm install --omit=dev --no-audit --no-fund "${YODEL_PACKAGE:-@intentius/sql-yodeler@$YODEL_VERSION}" $CHANT_PINS 2>/tmp/npm.err; then ok=1; break; fi; cat /tmp/npm.err >&2; grep -qE "E404|ETARGET" /tmp/npm.err || break; [ "$try" = 3 ] || sleep 45; done; test -n "$ok"; }',
  "npm cache clean --force",
  `ln -s ${PREFIX}/node_modules /node_modules`,
  // The image holds the version it is tagged with, or the build fails.
  'test "$(yodel --version)" = "$YODEL_VERSION"',
  "chant --version",
].join(" && ");

export const image = new Dockerfile({
  from: NODE_IMAGE,
  arg: ["YODEL_VERSION", "YODEL_PACKAGE", "CHANT_PINS"],
  env: [`PATH=${PREFIX}/node_modules/.bin:$PATH`],
  run: [
    // Jobs check out and fetch with git, as the template's pipelines do; a sealed wave (#48) verifies seals with ssh-keygen.
    "apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*",
    // A job often runs as another user than the one who owns its checkout
    // (on github.com the container job is root and the runner's user owns
    // the workspace), and git then refuses the checkout as dubious ownership.
    "git config --system --add safe.directory '*'",
    install,
  ],
  label: [
    'org.opencontainers.image.title="sql-yodeler"',
    'org.opencontainers.image.description="yodel, chant and the sql lexicon on Node 22, for CI jobs"',
    'org.opencontainers.image.version="${YODEL_VERSION}"',
    'org.opencontainers.image.source="https://github.com/INTENTIUS/sql-yodeler"',
    'org.opencontainers.image.licenses="Apache-2.0"',
  ],
  cmd: '["bash"]',
});
