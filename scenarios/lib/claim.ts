/**
 * What a claim is, and the two ways one stops early.
 *
 * A claim's body drives the built yodel bin in a scratch project and checks
 * the result against the database. It calls {@link hold} for each thing the
 * claim says; a check that does not hold throws a {@link Violation}. Under
 * BREAK=1 the body breaks the property first, and a Violation is then the
 * verdict "caught". Any other error (a command that timed out, a setup step
 * that failed) is a "fail" both ways: a claim that crashes under BREAK has
 * not shown that it would notice the property breaking.
 */

import type { Db } from "./db.js";

export type Dialect = "ch" | "pg";

export const dialectName = { ch: "clickhouse", pg: "postgres" } as const;

/** A check that did not hold. */
export class Violation extends Error {}

/** The feature the claim needs is not built yet; `needs` names its issue. */
export class Pending extends Error {
  constructor(readonly needs: string, detail = "") {
    super(detail || `needs ${needs}`);
  }
}

/** Throws a {@link Violation} unless `cond`. */
export function hold(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Violation(what);
}

export interface Ctx {
  claim: string;
  dialect: Dialect;
  /** BREAK=1: break the property this claim is about. */
  broken: boolean;
  /** The claim's own database (ClickHouse) or schema (Postgres) and its history. */
  db: Db;
  /** The environment name the scratch project's profile and Ops use: the claim's name. */
  env: string;
  /** A directory removed after the run. */
  work: string;
  log: (text: string) => void;
}

export type Body = (ctx: Ctx) => Promise<void>;

export interface Claim {
  name: string;
  /** What the README or #21 promises, in a line. */
  says: string;
  /**
   * Per dialect: the body, or the issue that builds the feature when there
   * is nothing to run yet. A dialect not listed does not apply.
   */
  dialects: Partial<Record<Dialect, Body | { needs: string }>>;
  /** Shared things a run holds while it runs (besides its own database): runs naming the same one never overlap. */
  shares?: string[];
  /** Minutes before the runner kills a run whose log stopped growing. Default: the runner's. */
  stallMinutes?: number;
}
