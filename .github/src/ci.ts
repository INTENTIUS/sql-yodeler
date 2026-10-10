/** `npm run check` on every pull request and on main. */

import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
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
  },
});
