/**
 * yodel's exit codes (#13). Every command uses them with these meanings;
 * each command's `--help` lists the ones it can return. `yodel --help` and
 * docs/README.md print {@link EXIT_CODES}, and test/exit-codes.test.ts
 * keeps them in agreement.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Something yodel will not do itself; drift found, for `yodel drift`. */
export const EXIT_NEEDS_OP = 2;
/** Something outstanding: an approval, pending migrations, lint errors. */
export const EXIT_OUTSTANDING = 3;
/** Refused, nothing done. */
export const EXIT_REFUSED = 4;
/** Another apply holds the lock. */
export const EXIT_LOCKED = 5;

/** Each code and what it means, one line each. */
export const EXIT_CODES: ReadonlyArray<readonly [number, string]> = [
  [EXIT_OK, "done, or nothing to do"],
  [EXIT_ERROR, "an error"],
  [EXIT_NEEDS_OP, "something yodel will not do itself (a change that needs an Op it does not run, a manual step); for yodel drift, drift found"],
  [EXIT_OUTSTANDING, "something outstanding: apply stopped at its approval gate, status found pending migrations, lint found errors"],
  [EXIT_REFUSED, "refused, nothing done: a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, a migration the environment it must run on first has not applied, an environment whose reader and writer are one identity"],
  [EXIT_LOCKED, "another apply holds the lock"],
];

/** Why `yodel plan` exits 0 with pending migrations, where `yodel status` exits 3. */
export const PLAN_PENDING_NOTE =
  "yodel plan exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use yodel status.";
