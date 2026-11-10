/**
 * The chant packages a project pins, in a module that imports nothing
 * (#298). src/chant-floor.ts re-exports them; scripts/templates-render.ts
 * pins both templates at the installed version of each.
 */

/** The packages a project pins, chant and the sql lexicon, at one version as the templates pin them. */
export const CHANT_PACKAGES = ["@intentius/chant", "@intentius/chant-lexicon-sql"] as const;
