/*
 * What the release cut compiles (chant.config.ts, environments: ["release"]):
 * this repository's own workflows, as .github/src declares them. The cut
 * builds nothing else; `npm run workflows` still renders the files.
 */

export { workflow as ci } from "../src/ci.js";
export { workflow as claims } from "../src/claims.js";
export { workflow as claimsWeekly } from "../src/claims-weekly.js";
export { workflow as pages } from "../src/pages.js";
export { workflow as templates } from "../src/templates.js";
