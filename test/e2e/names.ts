/**
 * The names the e2e suites write to: every ClickHouse database and Postgres
 * schema a suite makes starts with `<prefix>_<suite>`, the prefix from
 * YODEL_E2E_PREFIX (default yodel_e2e) and the suite part distinct per
 * suite, so no two suites share a database or schema and a run stays inside
 * its prefix:
 *
 *   YODEL_E2E_PREFIX=yodel_54 npx vitest run test/e2e
 *
 * The fixtures write FIXTURE_NAME where the suite's name goes; e2eProject
 * copies one with that name replaced.
 */

import { projectFrom } from "../helpers/run.js";

function prefix(value: string | undefined): string {
  const p = value === undefined || value === "" ? "yodel_e2e" : value;
  if (!/^[a-z][a-z0-9_]*$/.test(p)) throw new Error(`YODEL_E2E_PREFIX ${JSON.stringify(p)}: lower case letters, digits and underscores, starting with a letter`);
  return p;
}

export const PREFIX = prefix(process.env.YODEL_E2E_PREFIX);

/** The suite's own name, `<prefix>_<suite>`; anything else the suite makes starts with it. */
export const suiteName = (suite: string): string => `${PREFIX}_${suite}`;

/** What a fixture writes in place of its suite's name. */
export const FIXTURE_NAME = "yodel_e2e_fixture";

/** A copy of test/fixtures/<fixture> (see projectFrom) with FIXTURE_NAME replaced by `name`. */
export function e2eProject(fixture: string, name: string): { dir: string; dispose: () => void } {
  return projectFrom(fixture, (text) => text.replaceAll(FIXTURE_NAME, name));
}
