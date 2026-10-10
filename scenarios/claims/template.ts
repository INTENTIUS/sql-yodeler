/**
 * The starter template (#17), end to end on a local Forgejo
 * (scenarios/forges/forgejo.ts says which variables it reads). The body is
 * the one every template claim runs: scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { forgejoForge } from "../forges/forgejo.js";
import { templateBody } from "../forges/template-body.js";

const body = templateBody(forgejoForge);

export const templateClaim: Claim = {
  name: "template",
  says: "a project from the starter template, on Forgejo: apply only after approval, lint with replay and the plan comment on a pull request, and the approved change applied on merge; a sealed wave applies only on an approval sealed by a signer listed at the base, and a pr-review wave on the review of a writer other than the author",
  dialects: { ch: body, pg: body },
  shares: ["forgejo"],
  stallMinutes: 12,
};
