/**
 * Replaying a ClickHouse history: the server `sql.profiles.<env>` binds (the
 * emulator, `chant emulator up --lexicon sql`), statements sent as
 * `yodel apply` sends them (rendered for the environment's topology, a
 * mutation waited for), rebuild steps run as apply runs them, and each
 * migration's recorded schema compared with what the server then holds, the
 * way `chant sql plan` compares a build with a server (chant's normalizer,
 * then the server's own formatter for expressions the rules leave
 * different).
 *
 * The comparison reads every database the history names, so an object the
 * replay made that the recorded schema leaves out is a difference too, and
 * so is a database a migration should have dropped. chant's working objects
 * (a rebuild's retained `__chant_old` table) are not read, as a plan does
 * not read them.
 *
 * Functions, users, roles and row policies (#46) belong to no database (a
 * row policy outlives its table's), so emptying the databases leaves them:
 * the ones the history declares are counted as occupying the server and
 * dropped with the databases. A grantee's grants go with the grantee.
 * A user declared without `IDENTIFIED` is the environment's to create, with
 * its password, and no migration creates it: the replay stands in for the
 * environment and creates it with a random password before the first
 * statement, so the grants and `ALTER USER` statements that name it run,
 * and gives it its declared clauses (`DEFAULT ROLE`, `SETTINGS`, ...)
 * before each migration is compared, as the environment that made it as
 * declared would ({@link alterToDeclared}).
 */

import { randomBytes } from "node:crypto";
import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import type { StatementStep } from "@intentius/chant-lexicon-sql/migration-statements";
import { YodelError, type Environment, type Project } from "../project.js";
import { environmentSettings } from "../config/settings.js";
import { httpPort, type ClickHousePort } from "../history/index.js";
import type { Migration } from "../migrations/index.js";
import { renderForEnvironment } from "../topology/render.js";
import { defaultStepRunner, planStep, type RebuildReceiptStore, type StepRunner } from "../steps/index.js";
import type { OpStepOutcome, ReplayChange, ReplayDriver } from "./replay.js";

const SYSTEM = new Set(["system", "information_schema", "INFORMATION_SCHEMA"]);
const DEFAULT = "default";

const ident = (s: string) => `\`${s.replace(/`/g, "``")}\``;
const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export interface ClickHouseReplayOptions {
  processEnv?: NodeJS.ProcessEnv;
  /** The server, in place of an HTTP port to the bound endpoint. */
  port?: ClickHousePort;
  /** Runs a rebuild step. Default: chant's local executor, as apply runs it. */
  runStep?: StepRunner;
  log?: (line: string) => void;
}

/** The kinds that belong to no database: a function, a user, a role, a grantee's grants. */
const GLOBAL_KINDS = new Set(["function", "user", "role", "grants"]);

/** The databases a ClickHouse build output names, with bare names in `defaultDatabase`. */
export async function clickhouseDatabases(schema: unknown, defaultDatabase: string): Promise<string[]> {
  const { schemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/schema");
  return [...new Set(schemaFromBuildOutput(JSON.stringify(schema), defaultDatabase).filter((o) => !GLOBAL_KINDS.has(o.canonical.kind)).map((o) => o.canonical.database ?? o.canonical.name))];
}

/** A function, user, role or row policy a history declares, which emptying its databases does not remove. */
export interface GlobalObject {
  kind: "function" | "user" | "role" | "rowPolicy";
  name: string;
  /** A user declared without `IDENTIFIED`, which the environment creates. */
  withheld?: true;
  /** A row policy's table, `database.table`. */
  on?: string;
}

/** The functions, users, roles and row policies a ClickHouse build output declares. */
export async function clickhouseGlobals(schema: unknown, defaultDatabase: string): Promise<GlobalObject[]> {
  const { schemaFromBuildOutput } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/schema");
  return schemaFromBuildOutput(JSON.stringify(schema), defaultDatabase).flatMap((o): GlobalObject[] => {
    const c = o.canonical;
    if (c.kind === "user" && c.access?.identified === undefined) return [{ kind: "user", name: c.name, withheld: true }];
    if (c.kind === "function" || c.kind === "user" || c.kind === "role") return [{ kind: c.kind, name: c.name }];
    if (c.kind === "rowPolicy") return [{ kind: "rowPolicy", name: c.name, on: `${c.database ?? defaultDatabase}.${c.table ?? ""}` }];
    return [];
  });
}

const CREATE_USER = /^\s*CREATE\s+USER\s+(?:IF\s+NOT\s+EXISTS\s+|OR\s+REPLACE\s+)?(`(?:[^`]|``)*`|[^\s,]+)(?:\s+ON\s+CLUSTER\s+\S+)?/i;

/**
 * A user declared without `IDENTIFIED`, given its declared clauses:
 * `CREATE USER u DEFAULT ROLE r` as `ALTER USER u DEFAULT ROLE r`, or
 * `undefined` when it declares none (or is not such a user).
 */
export function alterToDeclared(ddl: string): string | undefined {
  const m = CREATE_USER.exec(ddl);
  if (!m || /\bIDENTIFIED\b/i.test(ddl)) return undefined;
  const rest = ddl.slice(m[0].length).trim().replace(/;\s*$/, "");
  return rest === "" ? undefined : `ALTER USER ${m[1] ?? ""} ${rest}`;
}

const KEYWORD: Record<GlobalObject["kind"], string> = { function: "FUNCTION", user: "USER", role: "ROLE", rowPolicy: "ROW POLICY" };
const onTable = (on: string) => on.split(".").map(ident).join(".");

/** `DROP ... IF EXISTS` for one, row policies before the users and roles they apply to. */
export const dropGlobal = (g: GlobalObject): string => `DROP ${KEYWORD[g.kind]} IF EXISTS ${ident(g.name)}${g.on !== undefined ? ` ON ${onTable(g.on)}` : ""}`;

/** The replay driver for `env`, a ClickHouse environment, over the history `ordered`. */
export async function clickhouseReplay(project: Project, env: Environment, ordered: readonly Migration[], options: ClickHouseReplayOptions = {}): Promise<ReplayDriver> {
  const processEnv = options.processEnv ?? process.env;
  const settings = environmentSettings(project, env.name, processEnv);
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(target)) throw new YodelError(target.detail);
  const endpoint: ClickHouseEndpoint = target.endpoint;
  const topology = settings.topology;
  const defaultDatabase = (m: Migration) => m.document.defaultDatabase ?? target.defaultDatabase;

  const named = new Set<string>();
  const globals = new Map<string, GlobalObject>();
  for (const m of ordered) {
    for (const d of await clickhouseDatabases(m.document.schema, defaultDatabase(m))) named.add(d);
    for (const g of await clickhouseGlobals(m.document.schema, defaultDatabase(m))) {
      // Withheld in one migration and created in another is created by the history: not the replay's to make.
      const seen = globals.get(dropGlobal(g));
      const made: GlobalObject = { kind: g.kind, name: g.name, ...(g.on !== undefined ? { on: g.on } : {}) };
      globals.set(dropGlobal(g), seen && !(seen.withheld && g.withheld) ? made : g);
    }
  }
  const order: Record<GlobalObject["kind"], number> = { rowPolicy: 0, user: 1, role: 2, function: 3 };
  const declaredGlobals = [...globals.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  const scope = [...named].sort();
  const system = scope.filter((d) => SYSTEM.has(d));
  if (system.length > 0) throw new YodelError(`the history declares objects in ${system.join(", ")}, the server's own database; there is nothing a replay can start fresh there`);
  if (scope.includes(settings.historyDatabase)) {
    throw new YodelError(`the history declares objects in ${settings.historyDatabase}, the migration history's own database (${env.name}); the replay empties every database it replays into, so it refuses to touch that one`);
  }

  const port = options.port ?? (await httpPort(endpoint));
  const log = options.log ?? (() => undefined);
  const runStep = options.runStep ?? defaultStepRunner;

  /** The declared functions, users, roles and row policies the server holds, as `<kind> <name>`. */
  const globalsThere = async (): Promise<GlobalObject[]> => {
    const there = async (kind: GlobalObject["kind"], sql: string) => new Set((await port.query<{ name: string }>(sql)).map((r) => r.name));
    const names = (kind: GlobalObject["kind"]) => declaredGlobals.filter((g) => g.kind === kind).map((g) => quote(g.kind === "rowPolicy" ? `${g.name} ON ${g.on ?? ""}` : g.name));
    const out: GlobalObject[] = [];
    const sets: Array<[GlobalObject["kind"], string]> = [
      ["function", `SELECT name FROM system.functions WHERE origin = 'SQLUserDefined' AND name IN (${names("function").join(", ")})`],
      ["user", `SELECT name FROM system.users WHERE name IN (${names("user").join(", ")})`],
      ["role", `SELECT name FROM system.roles WHERE name IN (${names("role").join(", ")})`],
      ["rowPolicy", `SELECT concat(short_name, ' ON ', database, '.', table) AS name FROM system.row_policies WHERE name IN (${names("rowPolicy").join(", ")}) OR concat(short_name, ' ON ', database, '.', table) IN (${names("rowPolicy").join(", ")})`],
    ];
    for (const [kind, sql] of sets) {
      if (names(kind).length === 0) continue;
      const held = await there(kind, sql);
      out.push(...declaredGlobals.filter((g) => g.kind === kind && held.has(g.kind === "rowPolicy" ? `${g.name} ON ${g.on ?? ""}` : g.name)));
    }
    return out;
  };
  // The withheld users are made before the first statement after the server is emptied, and dropped with the rest.
  let environmentUsers = false;
  const describeGlobal = (g: GlobalObject) => `${g.kind === "rowPolicy" ? "row policy" : g.kind} ${g.name}${g.on !== undefined ? ` ON ${g.on}` : ""}`;

  const tablesInDefault = async () =>
    (await port.query<{ name: string }>(`SELECT name FROM system.tables WHERE database = ${quote(DEFAULT)} AND NOT is_temporary ORDER BY name`)).map((r) => r.name);

  return {
    dialect: "clickhouse",
    where: `${endpoint.url} (${target.source})`,
    scope,

    async occupied() {
      const others = scope.filter((d) => d !== DEFAULT);
      const there = others.length === 0 ? [] : (await port.query<{ name: string }>(`SELECT name FROM system.databases WHERE name IN (${others.map(quote).join(", ")}) ORDER BY name`)).map((r) => r.name);
      if (scope.includes(DEFAULT) && (await tablesInDefault()).length > 0) there.unshift(`${DEFAULT} (not empty)`);
      return [...there, ...(await globalsThere()).map(describeGlobal)];
    },

    async clear() {
      for (const d of scope) {
        if (d !== DEFAULT) await port.query(`DROP DATABASE IF EXISTS ${ident(d)} SYNC`);
        else for (const t of await tablesInDefault()) await port.query(`DROP TABLE IF EXISTS ${ident(DEFAULT)}.${ident(t)} SYNC`);
      }
      for (const g of declaredGlobals) await port.query(dropGlobal(g));
      environmentUsers = false;
    },

    async statement(_m: Migration, _index: number, step: StatementStep) {
      if (!environmentUsers) {
        for (const g of declaredGlobals.filter((x) => x.withheld)) {
          await port.query(`CREATE USER IF NOT EXISTS ${ident(g.name)} IDENTIFIED BY ${quote(randomBytes(24).toString("base64url"))}`);
          log(`created user ${g.name}, which the history declares without a password, with a random one, as the environment would`);
        }
        environmentUsers = true;
      }
      await port.query(renderForEnvironment(step.sql, topology), step.waitsForMutation ? { settings: { mutations_sync: "2" } } : {});
    },

    async opStep(m: Migration, index: number, opts: { receipts?: RebuildReceiptStore } = {}): Promise<OpStepOutcome> {
      const step = m.document.steps[index];
      if (!step) return { refused: `${m.id} has no step ${String(index)}` };
      const plan = planStep(step);
      if (plan.run !== "rebuild") return { refused: plan.run === "refused" ? plan.reason : `step ${String(index)} is not one the replay runs` };
      const { summary } = await runStep({ environment: env.name, projectDir: project.dir, port, endpoint, migration: m, index, plan, log: (line) => { log(`  ${line}`); }, ...(opts.receipts ? { rebuildReceipts: opts.receipts } : {}) });
      const s = summary as { swapped?: boolean } | undefined;
      return { ran: true, ...(s?.swapped !== undefined ? { note: s.swapped ? "swapped" : "not swapped" } : {}) };
    },

    async compare(m: Migration): Promise<ReplayChange[]> {
      for (const o of (m.document.schema.objects as Array<{ type?: string; ddl: string }>).filter((x) => x.type === "ClickHouse::User")) {
        const alter = alterToDeclared(o.ddl);
        if (alter) await port.query(renderForEnvironment(alter, topology));
      }
      const { keyedByQualifiedName, schemaFromBuildOutput, schemaFromServer } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/schema");
      const { diffSchemas } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/diff");
      const { dropFormattingOnly } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/server-format");
      const db = defaultDatabase(m);
      const { scopeOf } = await import("@intentius/chant-lexicon-sql/clickhouse/plan/normalize");
      const { declaredAccess } = await import("@intentius/chant-lexicon-sql/clickhouse/live/catalog");
      const declared = keyedByQualifiedName(schemaFromBuildOutput(JSON.stringify(m.document.schema), db, topology));
      // A function, user, role or grantee is its own scope (chant's scopeOf), read when the migration declares it.
      const scopes = new Set([...scope, ...declared.filter((o) => GLOBAL_KINDS.has(o.canonical.kind)).map((o) => scopeOf(o.canonical))]);
      const live = await schemaFromServer({ ...target, databases: scope, defaultDatabase: db }, scopes, undefined, declaredAccess(declared.map((o) => o.canonical)));
      const diff = diffSchemas(live, declared);
      const changes = await dropFormattingOnly(endpoint, diff.changes);
      const label = new Map(declared.map((o) => [o.key, `${o.exportName} (${o.key})`]));
      return changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    },

    close: () => Promise.resolve(),
  };
}
