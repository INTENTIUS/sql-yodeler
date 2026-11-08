/**
 * yodel's exit codes are chant's one exit-code table (#288, chant#4553), so a
 * pipeline reads the same number from yodel, terragucci and plywood. Every
 * command exits by these names; each command's `--help` lists the ones it can
 * return. `yodel --help` and docs/cli.md print {@link EXIT_CODES}, and
 * test/exit-codes.test.ts keeps them in agreement.
 *
 * The table is chant's `CHANT_EXIT` (`@intentius/chant/exit-codes`), which
 * every chant at yodel's floor exports (#319): yodel keeps no copy of it.
 */

import { CHANT_EXIT } from "@intentius/chant/exit-codes";

/** A name in chant's table. */
export type ExitName = keyof typeof CHANT_EXIT;

/** Done, or nothing to do. */
export const EXIT_OK: number = CHANT_EXIT.done;
/** Something broke, or a refusal no approval fixes. Usage and config errors too. */
export const EXIT_FAILED: number = CHANT_EXIT.failed;
/** Drift found, for `yodel drift`. */
export const EXIT_DRIFT: number = CHANT_EXIT.drift;
/** Stopped for a person: a gate, pending migrations, a migration the required environment has not applied, a step yodel will not run itself. */
export const EXIT_WAITING: number = CHANT_EXIT.waiting;
/** The approved plan no longer matches the plan that would apply now. */
export const EXIT_MOVED: number = CHANT_EXIT.moved;
/** Another apply holds the lock. */
export const EXIT_HELD: number = CHANT_EXIT.held;
/** A newer push applies instead. yodel itself does not return it: `yodel apply --stand-down` exits 0. */
export const EXIT_SUPERSEDED: number = CHANT_EXIT.superseded;
/** A policy rule denies the plan and no override counts. */
export const EXIT_DENIED: number = CHANT_EXIT.denied;
/** An answer at a confirmation that does not approve. */
export const EXIT_DECLINED: number = CHANT_EXIT.declined;
/** A job guard refused: the job runs where it is not set to run (`chant ci check-job`). yodel itself does not return it: the guard in a generated job exits 9 before yodel starts. */
export const EXIT_MISPLACED: number = CHANT_EXIT.misplaced;

/** Each code yodel returns and what it means, one line each. */
export const EXIT_CODES: ReadonlyArray<readonly [number, string]> = [
  [EXIT_OK, "done, or nothing to do"],
  [EXIT_FAILED, "failed, or refused for a reason no approval fixes: a bad config, a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, an environment whose reader and writer are one identity, a command that writes run with an environment's reader, lint errors"],
  [EXIT_DRIFT, "for yodel drift, drift found"],
  [EXIT_WAITING, "waiting for a person: apply stopped at its approval gate, status found pending migrations, a migration the environment it must run on first has not applied, a change that needs an Op yodel does not run, a manual step"],
  [EXIT_MOVED, "the plan moved: the approved plan, or the one a wave decided on, is not the plan that would apply now; nothing applied"],
  [EXIT_HELD, "another apply holds the lock"],
  [EXIT_DENIED, "a policy rule denies the plan and no override counts; nothing applied"],
  [EXIT_DECLINED, "yodel approve: the answer was not the environment's name; nothing approved"],
];

/** Why `yodel plan` exits 0 with pending migrations, where `yodel status` exits 3. */
export const PLAN_PENDING_NOTE =
  "yodel plan exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use yodel status.";
