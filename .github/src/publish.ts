/*
 * Renders to .github/workflows/publish.yml, and only to that name: npm's
 * trusted publisher for this package names the workflow file.
 */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { IMAGE_REPOSITORY } from "./image.js";
import { chantPins, checkout, rendered, setupNode } from "./shared.js";

const comment = `Publishes @intentius/sql-yodeler to npm when a v<version> tag is pushed.
\`npm run release -- <version>\` (scripts/release.sh) pushes the tag, and only
on a main commit whose ci and claims runs are both green; AGENTS.md,
Releasing, has the steps.

npm trusts this workflow by its file name (a trusted publisher for
INTENTIUS/sql-yodeler, workflow publish.yml), so \`npm publish\` exchanges the
job's OIDC token for a short-lived publish token: no NPM_TOKEN secret. That
needs \`id-token: write\`, npm 11.5.1 or later and Node 22.14 or later.

Renaming this file breaks publishing until the trusted publisher is changed
on npmjs.com to the new name.

Once npm serves the release, the image job builds the CI image
(.github/image/Dockerfile, declared in .github/src/image.ts) from it for
linux/amd64 and linux/arm64, pushes it to ${IMAGE_REPOSITORY}:<version>
with provenance and an SBOM, and runs \`yodel --version\` from the pushed
image.`;

const publish = new Job({
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 30,
  permissions: { contents: "read", "id-token": "write" },
  outputs: { version: "${{ steps.version.outputs.version }}" },
  steps: [
    checkout(),
    // No registry-url: with it, setup-node writes an .npmrc whose
    // _authToken is NODE_AUTH_TOKEN, and npm publish sends that instead of
    // using the OIDC exchange.
    setupNode(24),
    new Step({ name: "npm 11.5.1 or later, for trusted publishing", run: "npm install -g npm@^11.5.1 && npm --version" }),
    new Step({
      name: "The tag matches package.json",
      id: "version",
      run: `version=$(node -p 'require("./package.json").version')
if [ "$GITHUB_REF_NAME" != "v$version" ]; then
  echo "::error::tag $GITHUB_REF_NAME does not match package.json version $version (expected v$version)"
  exit 1
fi
echo "version=$version" >> "$GITHUB_OUTPUT"
`,
    }),
    new Step({ run: "npm ci" }),
    new Step({ run: "npm run build" }),
    new Step({ run: "npx yodel --version" }),
    new Step({ run: "npm run check" }),
    new Step({
      name: "npm publish",
      env: {
        VERSION: "${{ steps.version.outputs.version }}",
      },
      run: `# A rerun after a publish that went through publishes nothing.
if [ "$(npm view "@intentius/sql-yodeler@$VERSION" version 2>/dev/null)" = "$VERSION" ]; then
  echo "@intentius/sql-yodeler@$VERSION is already on npm; nothing to publish"
  exit 0
fi
npm publish --access public
`,
    }),
  ],
});

// The release as a user gets it: installed from the registry into an empty
// directory, with no checkout, and run.
const smoke = new Job({
  needs: ["publish"],
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 20,
  steps: [
    setupNode(22, false),
    new Step({
      name: "npm install @intentius/sql-yodeler@${{ needs.publish.outputs.version }}, then yodel --version",
      env: { VERSION: "${{ needs.publish.outputs.version }}" },
      run: `dir=$(mktemp -d)
cd "$dir"
npm init -y >/dev/null
# The registry can take a few minutes to serve a new version.
for attempt in $(seq 1 30); do
  if npm install --prefer-online --no-audit --no-fund "@intentius/sql-yodeler@$VERSION"; then
    break
  fi
  if [ "$attempt" = 30 ]; then
    echo "::error::@intentius/sql-yodeler@$VERSION did not install from the registry after 30 attempts"
    exit 1
  fi
  echo "not installable yet (attempt $attempt/30); retrying in 20s"
  sleep 20
done
printed=$(npx --no-install yodel --version)
echo "yodel --version: $printed"
if [ "$printed" != "$VERSION" ]; then
  echo "::error::yodel --version printed $printed, not $VERSION"
  exit 1
fi
`,
    }),
  ],
});

// The CI image, from the release npm now serves (the smoke job waited for
// it). Each platform's build fails unless \`yodel --version\` prints the
// version, so nothing is pushed that does not hold it.
const image = new Job({
  needs: ["publish", "smoke"],
  "runs-on": "ubuntu-latest",
  "timeout-minutes": 30,
  // The only job that writes packages: the image to this repository's.
  permissions: { contents: "read", packages: "write" },
  env: { IMAGE: `${IMAGE_REPOSITORY}:\${{ needs.publish.outputs.version }}`, VERSION: "${{ needs.publish.outputs.version }}" },
  steps: [
    checkout(),
    // arm64 builds under emulation on the amd64 runner.
    new Step({ uses: "docker/setup-qemu-action@v3" }),
    new Step({ uses: "docker/setup-buildx-action@v3" }),
    new Step({
      name: "Log in to GHCR",
      env: { GH_TOKEN: "${{ github.token }}" },
      run: 'echo "$GH_TOKEN" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin',
    }),
    new Step({
      name: "Build both platforms and push, with provenance and an SBOM",
      run: `# A rerun after a push that went through pushes nothing.
if docker buildx imagetools inspect "$IMAGE" >/dev/null 2>&1; then
  echo "$IMAGE is already pushed; nothing to build"
  exit 0
fi
${chantPins}
docker buildx build --push --platform linux/amd64,linux/arm64 --provenance=mode=max --sbom=true \\
  --build-arg "YODEL_VERSION=$VERSION" --build-arg "CHANT_PINS=$CHANT_PINS" -f .github/image/Dockerfile -t "$IMAGE" .github/image
`,
    }),
    new Step({
      name: "yodel --version from the pushed image",
      run: `printed=$(docker run --rm --pull always "$IMAGE" yodel --version)
echo "yodel --version: $printed"
if [ "$printed" != "$VERSION" ]; then
  echo "::error::$IMAGE printed $printed, not $VERSION"
  exit 1
fi
digest=$(docker buildx imagetools inspect "$IMAGE" --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "$IMAGE@$digest" | tee -a "$GITHUB_STEP_SUMMARY"
`,
    }),
  ],
});

export const workflow = new Workflow({
  comment: rendered("publish.ts", comment),
  name: "publish",
  on: { push: { tags: ["v*"] } },
  permissions: { contents: "read" },
  concurrency: { group: "publish-${{ github.ref }}", "cancel-in-progress": false },
  jobs: { publish, smoke, image },
});
