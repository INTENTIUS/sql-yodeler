import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { checkout, claimsEnv, emulatorSteps, setupNode } from "./shared.js";

export const comment = `The scenario claims (scenarios/run.ts): every claim against the sql
emulator, plain and under BREAK=1. The template claim needs a Forgejo with
a runner, which this job has not, so it is skipped here. The record and
every run's log are kept as the run's artifacts.`;

export const workflow = new Workflow({
  name: "claims",
  on: { pull_request: null, push: { branches: ["main"] }, workflow_dispatch: null },
  permissions: { contents: "read" },
  jobs: {
    claims: new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 60,
      env: claimsEnv,
      steps: [
        checkout(),
        setupNode(22),
        new Step({ run: "npm ci" }),
        ...emulatorSteps(),
        new Step({ name: "Claims", run: "timeout 3000 npm run claims -- --record claims-record.json --skip template" }),
        new Step({
          if: "always()",
          uses: "actions/upload-artifact@v4",
          with: { name: "claims", path: "claims-record.json\nclaims-logs/\n" },
        }),
      ],
    }),
  },
});
