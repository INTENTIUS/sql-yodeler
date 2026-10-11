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
 *
 * A claim of several parts runs them in order with {@link runParts}, each
 * a function of its own. Under BREAK=1 every part breaks its own property
 * and the run is caught only when each part caught its own break; under
 * BREAK=<part> that part alone is broken and the others must hold. A part
 * may run on some dialects only (its entry names them).
 *
 * A claim rolled up from several ({@link rollup}) runs each member's body in
 * turn, one claim run in place of several.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

/** A broken run that held: the property was broken and no check saw it. */
export class NotCaught extends Error {}

/** Throws a {@link Violation} unless `cond`. */
export function hold(cond: boolean, what: string): asserts cond {
  if (!cond) throw new Violation(what);
}

export interface Ctx {
  claim: string;
  dialect: Dialect;
  /** BREAK=1: break the property this claim is about. Inside a part, whether that part is broken. */
  broken: boolean;
  /** BREAK=<part>: the one part a run of a claim with parts breaks; undefined under BREAK=1 (every part) or a plain run. */
  breaking?: string;
  /** The claim's own database (ClickHouse) or schema (Postgres) and its history. */
  db: Db;
  /** The environment name the scratch project's profile and Ops use: the claim's name, with -break on a broken run. */
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
  /**
   * Shared things a run holds while it runs (besides its own database): runs
   * naming the same one never overlap. `<dialect>:<thing>` is held by that
   * dialect's runs only (`ch:udf`: ClickHouse functions belong to the
   * server, not a database, so a run that reads every function waits for
   * the runs that make and drop their own).
   */
  shares?: string[];
  /** Minutes before the runner kills a run whose log stopped growing. Default: the runner's. */
  stallMinutes?: number;
  /** The parts {@link runParts} runs, in order; BREAK=<part> breaks one of them alone. */
  parts?: readonly string[];
  /** The parts that run on some dialects only, and those dialects ({@link partDialects}); a part not named runs on every dialect the claim does. */
  partDialects?: Readonly<Record<string, readonly Dialect[]>>;
}

export type Part<S> = (ctx: Ctx, state: S) => Promise<void>;

/** A part as {@link runParts} takes it: its name, its function, and the dialects it runs on when not all of the claim's. */
export type PartEntry<S> = readonly [name: string, part: Part<S>, dialects?: readonly Dialect[]];

/** The names of `parts`, for {@link Claim.parts}. */
export const partNames = (parts: ReadonlyArray<PartEntry<never>>): string[] => parts.map(([name]) => name);

/** The parts of `parts` that run on some dialects only, for {@link Claim.partDialects}. */
export function partDialects(parts: ReadonlyArray<PartEntry<never>>): Record<string, readonly Dialect[]> {
  return Object.fromEntries(parts.flatMap(([name, , dialects]) => (dialects ? [[name, dialects] as const] : [])));
}

/** Whether `claim`'s part `part` runs on `dialect`. */
export const partRunsOn = (claim: Pick<Claim, "partDialects">, part: string, dialect: Dialect): boolean => claim.partDialects?.[part]?.includes(dialect) ?? true;

/**
 * Runs a claim's parts in order on one state (a project, a cluster), each
 * with `ctx.broken` saying whether that part is the one broken.
 *
 * Plain, a part that does not hold stops the run, the Violation naming the
 * part. Broken, every part runs: a broken part must throw a Violation (it
 * caught its own break) and a part not broken must hold, so each part is
 * written to go on from whatever the parts before it left, broken or not.
 * The run is caught when every broken part caught its break; otherwise it
 * fails, naming the part that held with its property broken.
 */
export async function runParts<S>(ctx: Ctx, state: S, parts: ReadonlyArray<PartEntry<S>>): Promise<void> {
  // A part that runs on other dialects only is not this run's.
  const here = parts.filter(([, , dialects]) => dialects === undefined || dialects.includes(ctx.dialect));
  const names = here.map(([n]) => n);
  if (ctx.breaking !== undefined && !names.includes(ctx.breaking)) throw new Error(`BREAK=${ctx.breaking}: ${ctx.claim}'s parts on ${dialectName[ctx.dialect]} are ${names.join(", ")}`);
  const caught: string[] = [];
  const held: string[] = [];
  for (const [name, part] of here) {
    const broken = ctx.broken && (ctx.breaking === undefined || ctx.breaking === name);
    ctx.log(`part ${name}${broken ? " (broken)" : ""}`);
    try {
      await part({ ...ctx, broken }, state);
    } catch (e) {
      if (!(e instanceof Violation)) throw e;
      if (!broken) throw new (ctx.broken ? Error : Violation)(`${name}: ${e.message}`);
      ctx.log(`part ${name} caught its break: ${e.message}`);
      caught.push(`${name}: ${e.message}`);
      continue;
    }
    if (broken) held.push(name);
  }
  if (held.length) throw new NotCaught(`${held.join(", ")} held with ${held.length === 1 ? "its property" : "their properties"} broken`);
  if (caught.length) throw new Violation(caught.join("; "));
}

/**
 * One claim made of several members, run one after another in one claim
 * run: fewer runs, each paying its setup once. Each member's body runs as it
 * would alone, on the claim's database reset before it and a work directory
 * of its own, with `ctx.claim` its own name.
 *
 * The parts are the members' parts, each named `<prefix>-<part>`, the
 * prefix the member's name unless given (a member whose prefix is the
 * claim's name keeps its part names), and a member with no parts is one
 * part, its prefix. Under BREAK=1 every member breaks its own property and
 * must catch it; under BREAK=<part> the member that owns the part breaks it
 * alone and the others run plain and must hold. A member runs on its own
 * dialects only.
 */
export function rollup(name: string, entries: ReadonlyArray<Claim | readonly [prefix: string, member: Claim]>, extra: Partial<Pick<Claim, "shares" | "stallMinutes">> = {}): Claim {
  const members = entries.map((e) => ("name" in e ? { prefix: e.name, m: e } : { prefix: e[0], m: e[1] }));
  const allDialects = [...new Set(members.flatMap(({ m }) => Object.keys(m.dialects) as Dialect[]))];
  const owners = new Map<string, { member: Claim; part?: string }>();
  const dialectsOf: Record<string, readonly Dialect[]> = {};
  for (const { prefix, m } of members) {
    const mine = Object.keys(m.dialects) as Dialect[];
    for (const part of m.parts ?? [undefined]) {
      const q = part === undefined ? prefix : prefix === name ? part : `${prefix}-${part}`;
      if (owners.has(q)) throw new Error(`rollup ${name}: two members have a part named ${q}`);
      owners.set(q, part === undefined ? { member: m } : { member: m, part });
      const ds = (part === undefined ? undefined : m.partDialects?.[part]) ?? mine;
      if (ds.length < allDialects.length) dialectsOf[q] = ds;
    }
  }
  const body =
    (dialect: Dialect): Body =>
    async (ctx) => {
      const target = ctx.breaking === undefined ? undefined : owners.get(ctx.breaking);
      const caught: string[] = [];
      const held: string[] = [];
      let first = true;
      for (const { m } of members) {
        const run = m.dialects[dialect];
        if (run === undefined) continue;
        if (typeof run !== "function") throw new Pending(run.needs);
        if (!first) await ctx.db.reset();
        first = false;
        const work = join(ctx.work, m.name);
        mkdirSync(work, { recursive: true });
        const broken = ctx.broken && (target === undefined || target.member === m);
        const breaking = broken ? target?.part : undefined;
        ctx.log(`member ${m.name}${broken ? " (broken)" : ""}`);
        const mctx: Ctx = { ...ctx, claim: m.name, broken, work };
        if (breaking === undefined) delete mctx.breaking;
        else mctx.breaking = breaking;
        try {
          await run(mctx);
        } catch (e) {
          if (e instanceof NotCaught && broken) {
            held.push(`${m.name}: ${e.message}`);
            continue;
          }
          if (!(e instanceof Violation)) throw e;
          if (!broken) throw new (ctx.broken ? Error : Violation)(`${m.name}: ${e.message}`);
          caught.push(`${m.name}: ${e.message}`);
          continue;
        }
        if (broken) held.push(m.name);
      }
      if (held.length) throw new NotCaught(`${held.join("; ")} held with the property broken`);
      if (caught.length) throw new Violation(caught.join("; "));
    };
  const stalls = members.flatMap(({ m }) => (m.stallMinutes === undefined ? [] : [m.stallMinutes]));
  const stallMinutes = extra.stallMinutes ?? (stalls.length ? Math.max(...stalls) : undefined);
  const shares = [...new Set([...members.flatMap(({ m }) => m.shares ?? []), ...(extra.shares ?? [])])];
  return {
    name,
    says: members.map(({ m }) => m.says).join("; "),
    dialects: Object.fromEntries(allDialects.map((d) => [d, body(d)])),
    parts: [...owners.keys()],
    ...(Object.keys(dialectsOf).length ? { partDialects: dialectsOf } : {}),
    ...(shares.length ? { shares } : {}),
    ...(stallMinutes !== undefined ? { stallMinutes } : {}),
  };
}
