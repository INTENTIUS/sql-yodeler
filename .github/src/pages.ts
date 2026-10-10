import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { checkout, rendered } from "./shared.js";

const comment = `Builds docs-site/ and publishes it to GitHub Pages, at
https://intentius.io/sql-yodeler/, on every push to main. The pages come
from docs/*.md at build time (docs-site/pages.mjs); the build fails when the
output has an internal link that leads nowhere
(docs-site/check-dist.mjs). The ci workflow runs the same build on every
pull request.`;

type AStep = InstanceType<typeof Step>;

/** Node and docs-site's own dependencies, then the build: the steps ci.ts runs too. */
export const siteBuildSteps = (): AStep[] => [
  new Step({
    uses: "actions/setup-node@v4",
    with: { "node-version": 22, cache: "npm", "cache-dependency-path": "docs-site/package-lock.json" },
  }),
  new Step({ name: "npm ci", "working-directory": "docs-site", run: "npm ci" }),
  new Step({ name: "Build the site", "working-directory": "docs-site", run: "npm run build" }),
];

// These two run with the Pages and OIDC scopes, so they are pinned by SHA.
const uploadPagesArtifact = "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9"; // v5.0.0
const deployPages = "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346"; // v5.0.1

export const workflow = new Workflow({
  comment: rendered("pages.ts", comment),
  name: "pages",
  on: { push: { branches: ["main"] }, workflow_dispatch: null },
  permissions: { contents: "read" },
  // One publish at a time, never cancelled part way.
  concurrency: { group: "pages", "cancel-in-progress": false },
  jobs: {
    build: new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [
        checkout(),
        ...siteBuildSteps(),
        new Step({ name: "Upload the site", uses: uploadPagesArtifact, with: { path: "docs-site/dist" } }),
      ],
    }),
    deploy: new Job({
      needs: ["build"],
      // Pages needs a public repository on this plan; until then the job is skipped.
      if: "${{ !github.event.repository.private }}",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      // The only job that publishes.
      permissions: { contents: "read", pages: "write", "id-token": "write" },
      environment: { name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}" },
      steps: [new Step({ id: "deployment", name: "Deploy to GitHub Pages", uses: deployPages })],
    }),
  },
});
