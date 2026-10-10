/** `npm run check`, and the docs site's build, on every pull request and on main. */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { siteBuildSteps } from "./pages.js";
import { checkout, setupNode } from "./shared.js";

export const workflow = new Workflow({
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
      ],
    }),
    // The build pages.yml publishes from main, so a page that would fail it
    // fails here first.
    "docs-site": new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [checkout(), ...siteBuildSteps()],
    }),
  },
});
