# Rendered from .github/src/image.ts by `npm run workflows`. Edit that file, not this one.
#
# The CI image's Chainguard set, ghcr.io/intentius/sql-yodeler:<version>-chainguard:
# Chainguard's node image (Node 26 on its pinned digest, not the Node 22 of the
# Debian image), yodel, chant and the sql lexicon, ending as user 65532. A
# release's cut builds it from npm pack of the commit (chant.config.ts,
# release.images), and publish.yml pushes it with the npm release.
#
# Build arguments:
#   YODEL_VERSION  the version `yodel --version` must print, and the one
#                  installed from npm unless YODEL_PACKAGE names another (required)
#   YODEL_PACKAGE  what `npm install` installs, by default
#                  @intentius/sql-yodeler@$YODEL_VERSION. The build context is
#                  mounted at /ctx, so a tarball from `npm pack` in the
#                  context installs as /ctx/<file>.tgz.
#   CHANT_PINS     @intentius/chant packages at exact versions, installed
#                  beside yodel so its chant ranges resolve to them (ci.yml
#                  and chant.config.ts pass package-lock.json's)
#
#   docker build -f .github/image-chainguard/Dockerfile --build-arg YODEL_VERSION=0.1.0 .github/image-chainguard

FROM cgr.dev/chainguard/node:latest-dev@sha256:8e8d45dd674724ccc71aed270223c3e2efc74edde6c841158d618d2baaaf5527
USER root
ARG YODEL_VERSION
ARG YODEL_PACKAGE
ARG CHANT_PINS
ENV USER=yodel
ENV HOME=/tmp
ENV NODE_DISABLE_COMPILE_CACHE=1
ENV npm_config_logs_max=0
ENV CHANT_IMAGE_USER=65532
ENV PATH=/opt/yodel/node_modules/.bin:$PATH
RUN apk add --no-cache git=2.56.1-r1 ca-certificates=20261020-r0 openssh-client=10.6_p2-r0 || { echo "apk add failed. If Wolfi no longer serves a pinned version, move the pin: a newer chant moves its own (WOLFI_PACKAGE_PINS), and chant release images --repin <file> moves an apk:<name>=<version> entry in your source; then render this Dockerfile again." >&2; exit 1; } && mkdir -p /usr/local/bin
RUN git config --system --add safe.directory '*'
RUN mkdir -p /opt/yodel && chown 65532:65532 /opt/yodel
RUN --mount=type=bind,target=/ctx test -n "$YODEL_VERSION" && mkdir -p /opt/yodel && cd /opt/yodel && echo '{"name":"ci-image","private":true}' > package.json && { ok=; for try in 1 2 3; do if npm install --omit=dev --no-audit --no-fund "${YODEL_PACKAGE:-@intentius/sql-yodeler@$YODEL_VERSION}" $CHANT_PINS 2>/tmp/npm.err; then ok=1; break; fi; cat /tmp/npm.err >&2; grep -qE "E404|ETARGET" /tmp/npm.err || break; [ "$try" = 3 ] || sleep 45; done; test -n "$ok"; } && npm cache clean --force && ln -s /opt/yodel/node_modules /node_modules && test "$(yodel --version)" = "$YODEL_VERSION" && chant --version
LABEL org.opencontainers.image.title="sql-yodeler"
LABEL org.opencontainers.image.description="yodel, chant and the sql lexicon on Chainguard's node image, for CI jobs"
LABEL org.opencontainers.image.version="${YODEL_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/INTENTIUS/sql-yodeler"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.base.name="cgr.dev/chainguard/node:latest-dev"
LABEL org.opencontainers.image.base.digest="sha256:8e8d45dd674724ccc71aed270223c3e2efc74edde6c841158d618d2baaaf5527"
LABEL io.intentius.chant.image.base="chainguard"
ENTRYPOINT []
CMD ["bash"]
USER 65532
