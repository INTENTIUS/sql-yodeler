/**
 * The starter template (#17), end to end on GitHub's pipelines: the
 * generated .github/workflows run by act, with a mock GitHub answering the
 * API and serving the repository (scenarios/forges/github.ts). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { githubForge } from "../forges/github.js";
import { templateBody } from "../forges/template-body.js";

const body = templateBody(githubForge);

export const templateGithub: Claim = {
  name: "template-github",
  says: "a project from the starter template, on GitHub Actions (act and a mock GitHub): apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge; a sealed wave applies only on an approval sealed by a signer listed at the base, and a pr-review wave on the review of a writer other than the author",
  dialects: { ch: body, pg: body },
  // act names its containers after the workflow and the job, so two runs at once would collide.
  shares: ["act"],
  stallMinutes: 12,
};
