#!/usr/bin/env bash
# release-image.sh: build the CI image, ghcr.io/intentius/sql-yodeler:<version>,
# as the OCI archive a release records (chant.config.ts, release.images).
#
# chant's cut runs this before the release's build, records the archive's
# digest and hands the archive to the publish job, whose oci target pushes it
# once npm has the package. The image installs yodel from `npm pack` of the
# commit being cut, not from npm, since the cut runs before the publish; it
# installs chant at the versions package-lock.json holds (CHANT_PINS).
#
# Both platforms go into one archive, an image index. Building arm64 on amd64
# needs QEMU's binfmt handlers: the publish workflow installs them, and
# Docker Desktop has them. buildx writes no attestations into the archive:
# chant attaches the provenance when it pushes.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
: "${SOURCE_DATE_EPOCH:=$(git log -1 --format=%ct)}"
export SOURCE_DATE_EPOCH
platforms="${YODEL_IMAGE_PLATFORMS:-linux/amd64,linux/arm64}"
builder="sql-yodeler-release"
version="$(node -p 'require("./package.json").version')"

ctx="$(mktemp -d)"
npm pack --silent --pack-destination "$ctx" >/dev/null
CHANT_PINS=$(node -p 'const l=require("./package-lock.json");Object.entries(l.packages).filter(([k,v])=>/^node_modules\/@intentius\/chant[^/]*$/.test(k)&&!v.dev).map(([k,v])=>k.slice(13)+"@"+v.version).join(" ")')

# An OCI archive with its timestamps rewritten needs the docker-container driver.
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi

mkdir -p dist/images
docker buildx build --builder "$builder" --platform "$platforms" \
  --provenance=false --sbom=false \
  --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
  --build-arg "YODEL_VERSION=$version" \
  --build-arg "YODEL_PACKAGE=/ctx/intentius-sql-yodeler-$version.tgz" \
  --build-arg "CHANT_PINS=$CHANT_PINS" \
  --output "type=oci,dest=dist/images/sql-yodeler.tar,rewrite-timestamp=true" \
  -f .github/image/Dockerfile "$ctx"
