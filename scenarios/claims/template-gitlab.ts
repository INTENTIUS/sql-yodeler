/**
 * The starter template (#17), end to end on GitLab CI: the generated
 * .gitlab-ci.yml on a local GitLab, with a runner of the claim's own
 * (scenarios/forges/gitlab.ts says which variables it reads). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { gitlabForge } from "../forges/gitlab.js";
import { templateBody } from "../forges/template-body.js";

const body = templateBody(gitlabForge);

export const templateGitlab: Claim = {
  name: "template-gitlab",
  says: "a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge",
  dialects: { ch: body, pg: body },
  // The GitLab runs under emulation on Apple silicon: one run at a time, and a long silence while it works.
  shares: ["gitlab"],
  stallMinutes: 20,
};
