/**
 * typecheck and lint, the tests, the templates, the docs site's build and
 * the CI image's, on every pull request and on main. Each runs in a job of
 * its own; `check`, the status main's branch protection requires, passes
 * when lint, test and templates did.
 */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { siteBuildSteps } from "./pages.js";
import { chantPins, checkout, rendered, setupNode } from "./shared.js";
import { templatesJob } from "./templates.js";

/** The files the templates check reads besides npm: a pull request that changes none of them skips it. */
const TEMPLATE_INPUTS = "^(templates/|scripts/templates-check\\.ts$|package\\.json$|package-lock\\.json$|\\.github/src/(ci|templates)\\.ts$)";

/** Checkout, Node with npm's cache, and `npm ci`, whose `prepare` builds dist/. */
const setup = () => [checkout(), setupNode(22), new Step({ run: "npm ci" })];

export const workflow = new Workflow({
  comment: rendered("ci.ts"),
  name: "ci",
  on: { pull_request: null, push: { branches: ["main"] } },
  permissions: { contents: "read" },
  // A new push to a pull request cancels its run still going; main's runs all finish.
  concurrency: { group: "ci-${{ github.ref }}", "cancel-in-progress": "${{ github.event_name == 'pull_request' }}" },
  jobs: {
    lint: new Job({
      "runs-on": "ubuntu-latest",
      steps: [...setup(), new Step({ run: "npx yodel --version" }), new Step({ run: "npm run typecheck" }), new Step({ run: "npm run lint" })],
    }),
    test: new Job({
      "runs-on": "ubuntu-latest",
      strategy: { "fail-fast": false, matrix: { shard: [1, 2] } },
      steps: [...setup(), new Step({ run: "npx vitest run --shard=${{ matrix.shard }}/2" })],
    }),
    // Whether the pull request changed what the templates check reads. On a
    // push to main the check always runs.
    changes: new Job({
      "runs-on": "ubuntu-latest",
      outputs: { templates: "${{ steps.diff.outputs.templates }}" },
      steps: [
        checkout(),
        new Step({
          id: "diff",
          env: { EVENT: "${{ github.event_name }}", BASE: "${{ github.event.pull_request.base.sha }}" },
          run: `if [ "$EVENT" != pull_request ]; then echo templates=true >> "$GITHUB_OUTPUT"; exit 0; fi
git fetch -q --depth=1 origin "$BASE"
if git diff --name-only "$BASE" HEAD | grep -qE '${TEMPLATE_INPUTS}'; then
  echo templates=true >> "$GITHUB_OUTPUT"
else
  echo "templates=false: the pull request changes nothing the templates check reads" | tee -a "$GITHUB_STEP_SUMMARY"
  echo templates=false >> "$GITHUB_OUTPUT"
fi
`,
        }),
      ],
    }),
    templates: templatesJob({ needs: ["changes"], if: "needs.changes.outputs.templates == 'true'" }),
    // The required status. It fails unless lint and test passed and
    // templates passed or was skipped.
    check: new Job({
      needs: ["lint", "test", "changes", "templates"],
      if: "always()",
      "runs-on": "ubuntu-latest",
      steps: [
        new Step({
          env: {
            LINT: "${{ needs.lint.result }}",
            TEST: "${{ needs.test.result }}",
            CHANGES: "${{ needs.changes.result }}",
            TEMPLATES: "${{ needs.templates.result }}",
          },
          run: `echo "lint: $LINT, test: $TEST, changes: $CHANGES, templates: $TEMPLATES"
[ "$LINT" = success ] && [ "$TEST" = success ] && [ "$CHANGES" = success ] && { [ "$TEMPLATES" = success ] || [ "$TEMPLATES" = skipped ]; }
`,
        }),
      ],
    }),
    // The build pages.yml publishes from main, so a page that would fail it
    // fails here first.
    "docs-site": new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [checkout({ lfs: true }), ...siteBuildSteps()],
    }),
    // The CI image publish.yml pushes on a release (.github/src/image.ts),
    // built from this checkout's package instead of npm's: it runs yodel,
    // and a project with no node_modules of its own builds and lints in it.
    image: new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      steps: [
        checkout(),
        setupNode(22),
        // npm pack below builds dist/ (prepare); the install needs no build of its own.
        new Step({ run: "npm ci --ignore-scripts" }),
        new Step({
          name: "Build the image from npm pack of this checkout",
          run: `version=$(node -p 'require("./package.json").version')
ctx=$(mktemp -d)
npm pack --silent --pack-destination "$ctx"
${chantPins}
docker build -f .github/image/Dockerfile --build-arg "YODEL_VERSION=$version" \\
  --build-arg "YODEL_PACKAGE=/ctx/intentius-sql-yodeler-$version.tgz" --build-arg "CHANT_PINS=$CHANT_PINS" -t yodel-ci "$ctx"
`,
        }),
        new Step({ name: "yodel --version from the image", run: "docker run --rm yodel-ci yodel --version" }),
        new Step({
          name: "The ClickHouse example builds and lints in the image, with no npm ci",
          run: `cp -R examples/clickhouse "$RUNNER_TEMP/project"
rm -rf "$RUNNER_TEMP/project/node_modules"
docker run --rm -v "$RUNNER_TEMP/project:/work" -w /work yodel-ci sh -c 'chant build src --lexicon sql -o /tmp/schema.json && yodel lint'
`,
        }),
      ],
    }),
  },
});
