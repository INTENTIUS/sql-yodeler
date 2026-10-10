/**
 * Adoption (#10): `yodel init --from <env>` reads a live database with
 * chant's import, writes its declarations, writes the baseline migration
 * holding them, and records the baseline applied without running it.
 *
 *   adopt(project, env, options)     the whole of it; takes back what it wrote on a failure
 *   preflight(project, env)          the refusals that need no server
 *   importLive(project, env)         chant import --from, in process: the IR and the files
 *   baselineRow(migration, input)    the history row that records a baseline
 *   isBaselineRow(row)               whether a row is one
 *   recordBaseline(venv, migration)  appends it under the apply lock
 *   planBaseline / executeBaseline   yodel init --baseline <env> (#115): the baseline recorded in another environment that holds its schema
 */

export * from "./adopt.js";
export * from "./baseline.js";
export * from "./files.js";
export * from "./live.js";
export * from "./second.js";
