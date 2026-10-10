/** Where `yodel test` (#54) finds a project's test files: tests/*.test.ts. */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Where test files are, under the project directory. */
export const TESTS_DIR = "tests";
const TEST_FILE = /\.test\.(ts|mts|js|mjs)$/;

/** The project's test files, by name; none when there is no tests/ directory. */
export function testFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(dir, TESTS_DIR));
  } catch {
    return [];
  }
  return names.filter((n) => TEST_FILE.test(n)).sort().map((n) => join(dir, TESTS_DIR, n));
}
