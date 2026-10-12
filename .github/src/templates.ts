import { Job, Step, Workflow } from "@intentius/chant-lexicon-github";
import { checkout, rendered, setupNode } from "./shared.js";

const comment = `Each starter template, made into a project with the yodel its range
resolves to on npm (scripts/templates-check.ts), once a day. ci.yml runs
the same check on a pull request only when the templates or what they
install changed; a template's result also depends on what npm serves, so
this catches a release of yodel or chant that breaks one.`;

/**
 * One job per template: \`npm run templates:check -- <template>\`. In this
 * repository the templates see ./src, so a template that needs unreleased
 * yodel fails here and nowhere else (#131).
 */
export const templatesJob = (opts: { needs?: string[]; if?: string } = {}) =>
  new Job({
    ...(opts.needs ? { needs: opts.needs } : {}),
    ...(opts.if ? { if: opts.if } : {}),
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    strategy: { "fail-fast": false, matrix: { template: ["clickhouse", "postgres"] } },
    steps: [
      checkout(),
      setupNode(22),
      new Step({ run: "npm ci" }),
      new Step({ name: "The template works with the published yodel", run: "npm run templates:check -- ${{ matrix.template }}" }),
    ],
  });

export const workflow = new Workflow({
  comment: rendered("templates.ts", comment),
  name: "templates",
  on: { schedule: [{ cron: "17 6 * * *" }], workflow_dispatch: null },
  permissions: { contents: "read" },
  jobs: { templates: templatesJob() },
});
