/**
 * Tests for migrations and schema objects (#54): what a project's
 * `tests/*.test.ts` files declare, and the helpers they declare it with.
 *
 *     import { defineTests, expectError, expectRows, expectValue } from "@intentius/sql-yodeler";
 *
 *     export default defineTests([
 *       {
 *         name: "fill-country fills every event's country",
 *         at: "20261010T0530-add-source",
 *         seed: ["INSERT INTO shop.events (id, kind, at) VALUES (1, 'view', '2026-06-01 10:00:00')"],
 *         expect: [expectValue("SELECT count() FROM shop.events WHERE country = ''", 0)],
 *       },
 *     ]);
 *
 * A case runs on a database of its own, built by `yodel test` from the
 * migrations: every migration up to `at` (all of them when `at` is not
 * given) is replayed into an empty database, the `seed` statements run,
 * the migrations after `at` up to `through` (default: the newest) run with
 * their steps, backfills included, and then each expectation is checked.
 * A case without `at` tests the schema as the newest migration leaves it:
 * a view's rows, a function's result, a constraint that refuses a row.
 */

/** Rows a query must return, in order: each row its column values in order. */
export interface RowsExpectation {
  kind: "rows";
  sql: string;
  rows: unknown[][];
}

/** The first column of the first row a query returns. */
export interface ValueExpectation {
  kind: "value";
  sql: string;
  value: unknown;
}

/** A statement that must fail; with `match`, with a message that contains it (a string) or matches it (a pattern). */
export interface ErrorExpectation {
  kind: "error";
  sql: string;
  match?: string | RegExp;
}

export type Expectation = RowsExpectation | ValueExpectation | ErrorExpectation;

export interface TestCase {
  /** Names the case in the output, in the JUnit file and for `--run`. */
  name: string;
  /** The migration the seed runs after. Default: the newest, so nothing runs after the seed. */
  at?: string;
  /** Statements run once the database is at `at`: the data the migrations after it meet. */
  seed?: string[];
  /** The last migration run after the seed. Default: the newest. */
  through?: string;
  /** Checked in order, after the migrations ran; every one is checked, even after one fails. */
  expect: Expectation[];
}

/** Types a test file's cases; returns them as given. */
export const defineTests = (cases: TestCase[]): TestCase[] => cases;

/** The query returns exactly `rows`, in order. Values compare as text: `1` and `"1"` are the same, a date as its ISO string. */
export const expectRows = (sql: string, rows: unknown[][]): RowsExpectation => ({ kind: "rows", sql, rows });

/** The query's first row's first column is `value`, compared as text. */
export const expectValue = (sql: string, value: unknown): ValueExpectation => ({ kind: "value", sql, value });

/** The statement fails; with `match`, with a message containing it (or matching it). */
export const expectError = (sql: string, match?: string | RegExp): ErrorExpectation => ({ kind: "error", sql, ...(match !== undefined ? { match } : {}) });
