/**
 * The starter template (#17), end to end on a local Forgejo
 * (scenarios/forges/forgejo.ts says which variables it reads): what only a
 * runner shows of yodel's own rendered pipelines. The approval, notify and
 * resume are chant's, and chant proves them against the forges. The body:
 * scenarios/forges/template-body.ts.
 */

import type { Claim } from "../lib/claim.js";
import { forgejoForge } from "../forges/forgejo.js";
import { templateBody, templatePartNames } from "../forges/template-body.js";

export const forge: Claim = {
  name: "forge",
  says: "a project from the ClickHouse starter template, on Forgejo: lint with replay and the plan comment on a pull request, its plan job unable to write, and the approved change applied on merge; the project's own job runs on the pull request; a forked migration fails lint and is annotated; a project with ci.apply: false and no apply pipeline passes yodel ci --check and gets the plan comment; the CI image pinned by digest runs a pull request's jobs; and the drift watch opens a tracking issue",
  // The rest of the run is the forge, not the dialect: npm run templates:check covers the Postgres template.
  dialects: { ch: templateBody(forgejoForge) },
  parts: templatePartNames(),
  shares: ["forgejo"],
  stallMinutes: 12,
};
