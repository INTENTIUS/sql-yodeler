/**
 * yodel's exit codes are chant's one exit-code table (#288, chant#4553), so a
 * pipeline reads the same number from yodel, terragucci and plywood. Every
 * command exits by these names; each command's `--help` lists the ones it can
 * return. `yodel --help` and docs/cli.md print {@link EXIT_CODES}, and
 * test/exit-codes.test.ts keeps them in agreement.
 *
 * The table is chant's `CHANT_EXIT`, read from `@intentius/chant/exit-codes`
 * by {@link useChantExitTable} when the installed chant has it. A chant
 * released before that subpath has no table to read, so yodel keeps
 * {@link FALLBACK_EXIT}, the same numbers.
 */

/** chant's table, as chant#4553 set it: the fallback for a chant that does not export it. */
export const FALLBACK_EXIT = {
  done: 0,
  failed: 1,
  drift: 2,
  waiting: 3,
  moved: 4,
  held: 5,
  superseded: 6,
  denied: 7,
  declined: 8,
} as const;

/** A name in chant's table. */
export type ExitName = keyof typeof FALLBACK_EXIT;

/* The codes are live bindings: each starts at the fallback's number, and useChantExitTable() sets them from chant's table. */

/** Done, or nothing to do. */
export let EXIT_OK: number = FALLBACK_EXIT.done;
/** Something broke, or a refusal no approval fixes. Usage and config errors too. */
export let EXIT_FAILED: number = FALLBACK_EXIT.failed;
/** Drift found, for `yodel drift`. */
export let EXIT_DRIFT: number = FALLBACK_EXIT.drift;
/** Stopped for a person: a gate, pending migrations, a migration the required environment has not applied, a step yodel will not run itself. */
export let EXIT_WAITING: number = FALLBACK_EXIT.waiting;
/** The approved plan no longer matches the plan that would apply now. */
export let EXIT_MOVED: number = FALLBACK_EXIT.moved;
/** Another apply holds the lock. */
export let EXIT_HELD: number = FALLBACK_EXIT.held;
/** A newer push applies instead. yodel itself does not return it: `yodel apply --stand-down` exits 0. */
export let EXIT_SUPERSEDED: number = FALLBACK_EXIT.superseded;
/** A policy rule denies the plan and no override counts. */
export let EXIT_DENIED: number = FALLBACK_EXIT.denied;
/** An answer at a confirmation that does not approve. */
export let EXIT_DECLINED: number = FALLBACK_EXIT.declined;

/** Each code yodel returns and what it means, one line each. */
export let EXIT_CODES: ReadonlyArray<readonly [number, string]> = exitCodes();

function exitCodes(): ReadonlyArray<readonly [number, string]> {
  return [
    [EXIT_OK, "done, or nothing to do"],
    [EXIT_FAILED, "failed, or refused for a reason no approval fixes: a bad config, a checksum mismatch, an applied migration gone from the directory, an out-of-order migration, a fork or another problem in the migrations directory, an environment whose reader and writer are one identity, a command that writes run with an environment's reader, lint errors"],
    [EXIT_DRIFT, "for yodel drift, drift found"],
    [EXIT_WAITING, "waiting for a person: apply stopped at its approval gate, status found pending migrations, a migration the environment it must run on first has not applied, a change that needs an Op yodel does not run, a manual step"],
    [EXIT_MOVED, "the plan moved: the approved plan, or the one a wave decided on, is not the plan that would apply now; nothing applied"],
    [EXIT_HELD, "another apply holds the lock"],
    [EXIT_DENIED, "a policy rule denies the plan and no override counts; nothing applied"],
    [EXIT_DECLINED, "yodel approve: the answer was not the environment's name; nothing approved"],
  ];
}

let loaded: Promise<"chant" | "fallback"> | undefined;

/**
 * Reads chant's table from the installed chant, once, and sets every code
 * from it. The import is lazy and its specifier a variable, so a published
 * chant without `@intentius/chant/exit-codes` (before chant#4553's release)
 * leaves the fallback in place. `main()` calls it before any verb runs.
 * Resolves to which table the codes came from.
 */
export function useChantExitTable(): Promise<"chant" | "fallback"> {
  loaded ??= (async () => {
    const specifier = "@intentius/chant/exit-codes";
    let table: Partial<Record<ExitName, unknown>> | undefined;
    try {
      table = ((await import(specifier)) as { CHANT_EXIT?: Partial<Record<ExitName, unknown>> }).CHANT_EXIT;
    } catch {
      return "fallback";
    }
    const names = Object.keys(FALLBACK_EXIT) as ExitName[];
    if (!table || !names.every((name) => typeof table[name] === "number")) return "fallback";
    const code = (name: ExitName): number => table[name] as number;
    EXIT_OK = code("done");
    EXIT_FAILED = code("failed");
    EXIT_DRIFT = code("drift");
    EXIT_WAITING = code("waiting");
    EXIT_MOVED = code("moved");
    EXIT_HELD = code("held");
    EXIT_SUPERSEDED = code("superseded");
    EXIT_DENIED = code("denied");
    EXIT_DECLINED = code("declined");
    EXIT_CODES = exitCodes();
    return "chant";
  })();
  return loaded;
}

/** Why `yodel plan` exits 0 with pending migrations, where `yodel status` exits 3. */
export const PLAN_PENDING_NOTE =
  "yodel plan exits 0 when migrations are pending: it reports, and a CI job that posts the plan on a pull request should not fail because the pull request adds a migration. To gate on pending migrations, use yodel status.";
