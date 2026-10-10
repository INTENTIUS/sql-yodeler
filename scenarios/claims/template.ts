/**
 * The starter template (#17), end to end on a local Forgejo
 * (scenarios/forges/forgejo.ts says which variables it reads). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { forgejoForge } from "../forges/forgejo.js";
import { templateBody, templatePartNames, type TemplateFeatures } from "../forges/template-body.js";

const features: TemplateFeatures = { resume: true, review: true, image: true, commandToken: true };
const body = templateBody(forgejoForge, features);

export const templateClaim: Claim = {
  name: "template",
  says: "a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge; a sealed wave applies only on an approval sealed by a signer listed at the base, and a pr-review wave on the review of a writer other than the author; a pull request job cannot write, a forked migration fails lint and is annotated, a stale or hand-edited pipeline fails yodel ci --check, a project with ci.apply: false and no apply pipeline passes it and gets the plan comment, the CI image pinned by digest runs a pull request's jobs, a command token source mints the reader's password, and the drift watch keeps one tracking issue",
  dialects: { ch: body, pg: body },
  parts: templatePartNames(features),
  shares: ["forgejo"],
  stallMinutes: 12,
};
