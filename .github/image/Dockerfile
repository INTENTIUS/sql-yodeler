# Rendered from .github/src/image.ts by `npm run workflows`. Edit that file, not this one.
#
# The CI image, ghcr.io/intentius/sql-yodeler:<version>: Node 22, yodel, chant
# and the sql lexicon. publish.yml builds and pushes it after the npm release.
#
# Build arguments:
#   YODEL_VERSION  the version to install from npm, and the version
#                  `yodel --version` must print (required)
#   YODEL_PACKAGE  what `npm install` installs, by default
#                  @intentius/sql-yodeler@$YODEL_VERSION. The build context is
#                  mounted at /ctx, so a tarball from `npm pack` in the
#                  context installs as /ctx/<file>.tgz.
#
#   docker build -f .github/image/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image

FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG YODEL_VERSION
ARG YODEL_PACKAGE
ENV PATH=/opt/yodel/node_modules/.bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
RUN git config --system --add safe.directory '*'
RUN --mount=type=bind,target=/ctx test -n "$YODEL_VERSION" && mkdir -p /opt/yodel && cd /opt/yodel && echo '{"name":"yodel-image","private":true}' > package.json && npm install --omit=dev --no-audit --no-fund "${YODEL_PACKAGE:-@intentius/sql-yodeler@$YODEL_VERSION}" && npm cache clean --force && ln -s /opt/yodel/node_modules /node_modules && test "$(yodel --version)" = "$YODEL_VERSION" && chant --version
LABEL org.opencontainers.image.title="sql-yodeler"
LABEL org.opencontainers.image.description="yodel, chant and the sql lexicon on Node 22, for CI jobs"
LABEL org.opencontainers.image.version="${YODEL_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/sql-yodeler"
LABEL org.opencontainers.image.licenses="Apache-2.0"
CMD ["bash"]
