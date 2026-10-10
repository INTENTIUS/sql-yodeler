import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { checkout, claimsEnv, emulatorSteps, setupNode } from "./shared.js";

export const comment = `Every claim, weekly, against @intentius/sql-yodeler as npm serves it
(\`npm i @intentius/sql-yodeler@latest\`), not against this checkout: the
claims link that install's node_modules (YODEL_CLAIMS_NODE_MODULES,
scenarios/lib/project.ts). The run rewrites the committed record,
scenarios/claims-record.json, and the status page made from it (npm run
claims:page, docs/claims.md), and when either changed, opens a pull
request from branch claims-weekly, or updates the one already open.
The template claim is skipped here, as in claims.yml.`;

const record = "scenarios/claims-record.json";
const page = "docs/claims.md";
const branch = "claims-weekly";

export const workflow = new Workflow({
  name: "claims-weekly",
  on: { schedule: [{ cron: "0 6 * * 1" }], workflow_dispatch: null },
  permissions: { contents: "read" },
  jobs: {
    claims: new Job({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 75,
      // Pushing the branch and opening the pull request.
      permissions: { contents: "write", "pull-requests": "write" },
      env: claimsEnv,
      steps: [
        checkout(),
        setupNode(22),
        // The checkout's own packages run the claims and the emulator; the
        // yodel under test is the one installed in the next step.
        new Step({ run: "npm ci" }),
        ...emulatorSteps(),
        new Step({
          name: "npm install @intentius/sql-yodeler@latest",
          id: "published",
          run: `dir="$RUNNER_TEMP/published"
mkdir -p "$dir"
cd "$dir"
npm init -y >/dev/null
npm install --no-audit --no-fund @intentius/sql-yodeler@latest
version=$(node -p 'require("./node_modules/@intentius/sql-yodeler/package.json").version')
echo "@intentius/sql-yodeler@$version"
echo "version=$version" >> "$GITHUB_OUTPUT"
echo "YODEL_CLAIMS_NODE_MODULES=$dir/node_modules" >> "$GITHUB_ENV"
`,
        }),
        // A failing claim still writes its row: the record says what failed,
        // and the job fails at the end, after the pull request.
        new Step({
          name: "Claims",
          id: "claims",
          "continue-on-error": true,
          run: `timeout 3000 npm run claims -- --record ${record} --skip template`,
        }),
        new Step({ name: "The status page", run: "npm run claims:page" }),
        new Step({
          name: "A pull request when the record changed",
          env: { GH_TOKEN: "${{ github.token }}", VERSION: "${{ steps.published.outputs.version }}" },
          run: `if [ -z "$(git status --porcelain -- ${record} ${page})" ]; then
  echo "the record and the page are unchanged"
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git switch -C ${branch}
git add -- ${record} ${page}
title="chore: weekly claims record for @intentius/sql-yodeler@$VERSION"
git commit -q -m "$title"
git push -f origin ${branch}
if [ -z "$(gh pr list --head ${branch} --state open --json number --jq '.[].number')" ]; then
  gh pr create --head ${branch} --title "$title" --body "Every claim but template, run weekly by claims-weekly.yml against @intentius/sql-yodeler@$VERSION from npm: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
fi
`,
        }),
        new Step({
          if: "always()",
          uses: "actions/upload-artifact@v4",
          with: { name: "claims-weekly", path: `${record}\nclaims-logs/\n` },
        }),
        new Step({
          name: "Fail when a claim failed",
          if: "steps.claims.outcome == 'failure'",
          run: "exit 1",
        }),
      ],
    }),
  },
});
