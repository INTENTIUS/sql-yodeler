/**
 * The floor's version and install line, in a module that imports nothing
 * (#298). src/chant-floor.ts re-exports them; src/commands/upgrade.ts reads
 * them from here, since chant-floor.ts imports the feature-detects, one of
 * which (src/mcp/tools.ts, through src/cli.ts) imports the commands, and a
 * `--help` text built at load would otherwise find them not yet defined when
 * chant-floor.ts is the first module loaded.
 */

/** The first chant (and sql lexicon) whose CI yodel's pipelines run on. */
export const CHANT_CI_FLOOR = "0.124.56";

/** The packages a project pins at the floor, chant and the sql lexicon, at one version as the templates pin them. */
export const CHANT_PACKAGES = ["@intentius/chant", "@intentius/chant-lexicon-sql"] as const;

/** The line that installs the floor, exact as the templates pin chant. */
export const installLine = (version: string = CHANT_CI_FLOOR): string => `npm install -E ${CHANT_PACKAGES.map((p) => `${p}@${version}`).join(" ")}`;
