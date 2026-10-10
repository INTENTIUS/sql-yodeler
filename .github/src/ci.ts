/** `npm run check`, the docs site's build and the CI image's, on every pull request and on main. */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { siteBuildSteps } from "./pages.js";
import { checkout, rendered, setupNode } from "./shared.js";

export const workflow = new Workflow({
  comment: rendered("ci.ts"),
  name: "ci",
  on: { pull_request: null, push: { branches: ["main"] } },
  permissions: { contents: "read" },
  jobs: {
    check: new Job({
      "runs-on": "ubuntu-latest",
      steps: [
        checkout(),
        setupNode(22),
        new Step({ run: "npm ci" }),
        new Step({ run: "npm run build" }),
        new Step({ run: "npx yodel --version" }),
        new Step({ run: "npm run check" }),
        // Each template made into a project with the yodel its range resolves
        // to on npm (#131): in this repository the templates see ./src, so a
        // template that needs unreleased yodel fails here and nowhere else.
        new Step({ name: "The templates work with the published yodel", run: "npm run templates:check" }),
      ],
    }),
    // The build pages.yml publishes from main, so a page that would fail it
    // fails here first.
    "docs-site": new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [checkout(), ...siteBuildSteps()],
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
        new Step({ run: "npm ci" }),
        new Step({
          name: "Build the image from npm pack of this checkout",
          run: `version=$(node -p 'require("./package.json").version')
ctx=$(mktemp -d)
npm pack --silent --pack-destination "$ctx"
docker build -f .github/image/Dockerfile --build-arg "YODEL_VERSION=$version" \\
  --build-arg "YODEL_PACKAGE=/ctx/intentius-sql-yodeler-$version.tgz" -t yodel-ci "$ctx"
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
