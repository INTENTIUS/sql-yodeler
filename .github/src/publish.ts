/*
 * Renders to .github/workflows/publish.yml, and only to that name: npm's
 * trusted publisher for this package names the workflow file.
 */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { checkout, setupNode } from "./shared.js";

export const comment = `Publishes @intentius/sql-yodeler to npm when a v<version> tag is pushed.
\`npm run release -- <version>\` (scripts/release.sh) pushes the tag, and only
on a main commit whose ci and claims runs are both green; AGENTS.md,
Releasing, has the steps.

npm trusts this workflow by its file name (a trusted publisher for
INTENTIUS/sql-yodeler, workflow publish.yml), so \`npm publish\` exchanges the
job's OIDC token for a short-lived publish token: no NPM_TOKEN secret. That
needs \`id-token: write\`, npm 11.5.1 or later and Node 22.14 or later.

Renaming this file breaks publishing until the trusted publisher is changed
on npmjs.com to the new name.`;

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
        // npm generates provenance by default under trusted publishing, but
        // only for a public source repository: this one is private, so there
        // is none. Saying so keeps npm from trying. Drop this once the
        // repository is public.
        NPM_CONFIG_PROVENANCE: "false",
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

export const workflow = new Workflow({
  name: "publish",
  on: { push: { tags: ["v*"] } },
  permissions: { contents: "read" },
  concurrency: { group: "publish-${{ github.ref }}", "cancel-in-progress": false },
  jobs: { publish, smoke },
});
