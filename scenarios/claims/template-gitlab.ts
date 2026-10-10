/**
 * The starter template (#17), end to end on GitLab CI: the generated
 * .gitlab-ci.yml on a local GitLab, with a runner of the claim's own
 * (scenarios/forges/gitlab.ts says which variables it reads). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { gitlabForge } from "../forges/gitlab.js";
import { templateBody, templatePartNames, type TemplateFeatures } from "../forges/template-body.js";

// No resume, reviews, image or command-token part here yet: GitLab has no resume or reviews, and the image and command-token parts are proven on Forgejo and GitHub.
const features: TemplateFeatures = { resume: false, review: false, image: false, commandToken: false };
const body = templateBody(gitlabForge, features);

export const templateGitlab: Claim = {
  name: "template-gitlab",
  says: "a project from the starter template, on GitLab CI: apply only after approval, lint with replay and the plan comment on a merge request, and the approved change applied on merge; a merge request job cannot write, a forked migration fails lint and keeps its code quality report, a stale or hand-edited pipeline fails yodel ci --check, and the drift watch keeps one tracking issue",
  dialects: { ch: body, pg: body },
  parts: templatePartNames(features),
  // The GitLab runs under emulation on Apple silicon: one run at a time, and a long silence while it works.
  shares: ["gitlab"],
  stallMinutes: 20,
};
