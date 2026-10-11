/**
 * The starter template (#17), end to end on GitHub's pipelines: the
 * generated .github/workflows run by act, with a mock GitHub answering the
 * API and serving the repository (scenarios/forges/github.ts). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { githubForge } from "../forges/github.js";
import { templateBody, templatePartNames, type TemplateFeatures } from "../forges/template-body.js";

const features: TemplateFeatures = { resume: true, review: true, image: true, commandToken: true };
const body = templateBody(githubForge, features);

export const github: Claim = {
  name: "github",
  says: "a project from the ClickHouse starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge; a sealed wave applies only on an approval sealed by a signer listed at the base, and a pr-review wave on the review of a writer other than the author; a pull request job cannot write, a forked migration fails lint and is annotated, a stale or hand-edited pipeline fails yodel ci --check, a project with ci.apply: false and no apply pipeline passes it and gets the plan comment, the CI image pinned by digest runs a pull request's jobs, a command token source mints the reader's password, and the drift watch keeps one tracking issue",
  // Forgejo runs both templates; GitHub the ClickHouse one, GitLab the Postgres one: the rest of the run is the forge, not the dialect.
  dialects: { ch: body },
  parts: templatePartNames(features),
  // act names its containers after the workflow and the job, so two runs at once would collide.
  shares: ["act"],
  stallMinutes: 12,
};
