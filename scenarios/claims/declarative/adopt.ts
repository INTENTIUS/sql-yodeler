import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hold, partDialects, partNames, runParts, type Claim, type Ctx, type PartEntry } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";
import { accessOnServer, manageAccess, reader } from "../../lib/access.js";
import { chAccessOnServer, chNames } from "../../lib/clickhouse-objects.js";
import { secondServer, type SecondServer } from "../../lib/second-server.js";
import { yodelBuild } from "../../lib/yodel-build.js";

/** The database a team already has, made by hand: no ownership markers, and data. `exec` runs SQL on the server it is made on (default the claim's). */
async function handMade(claim: Ctx, exec?: (sql: string) => Promise<void>): Promise<void> {
  const ctx: Ctx = exec ? { ...claim, db: { ...claim.db, exec } } : claim;
  const n = ctx.db.name;
  if (ctx.dialect === "ch") {
    await ctx.db.exec(`CREATE DATABASE ${n}`);
    await ctx.db.exec(`CREATE TABLE ${n}.events (id UInt64, ts DateTime, kind LowCardinality(String), payload String DEFAULT '') ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (kind, id) COMMENT 'raw events'`);
    await ctx.db.exec(`CREATE TABLE ${n}.daily (day Date, kind String, n UInt64) ENGINE = SummingMergeTree ORDER BY (day, kind)`);
    await ctx.db.exec(`CREATE VIEW ${n}.recent AS SELECT * FROM ${n}.events WHERE ts > now() - INTERVAL 1 DAY`);
    await ctx.db.exec(`INSERT INTO ${n}.events (id, ts, kind) VALUES (1, now(), 'click'), (2, now(), 'view')`);
    // A dictionary and a function (#46), and access control: a role, a user with a password (the environment's), a row policy and grants.
    const { reader: role, svc, fn } = chNames(ctx);
    await ctx.db.exec(`CREATE DICTIONARY ${n}.daily_n (day Date, n UInt64 DEFAULT 0) PRIMARY KEY day SOURCE(CLICKHOUSE(TABLE 'daily' DB '${n}')) LAYOUT(COMPLEX_KEY_HASHED()) LIFETIME(300)`);
    // A view calls the function, and ClickHouse stores the function's body in place of the call, so chant's import adopts the function by its body.
    // A function belongs to no database and the import reads every one on the server, so the body names the database: another run's function never matches this view.
    await ctx.db.exec(`CREATE FUNCTION ${fn} AS (x, k) -> concat('${n}:', toString(x * k))`);
    await ctx.db.exec(`CREATE VIEW ${n}.scaled AS SELECT id, ${fn}(id, 2) AS doubled FROM ${n}.events`);
    await ctx.db.exec(`CREATE ROLE ${role} SETTINGS max_threads = 4`);
    await ctx.db.exec(`CREATE USER ${svc} IDENTIFIED BY 'yodel-claims-only'`);
    await ctx.db.exec(`GRANT SELECT ON ${n}.events TO ${role}`);
    await ctx.db.exec(`GRANT ${role} TO ${svc}`);
    await ctx.db.exec(`ALTER USER ${svc} DEFAULT ROLE ${role}`);
    await ctx.db.exec(`CREATE ROW POLICY clicks ON ${n}.events FOR SELECT USING kind = 'click' TO ${role}`);
  } else {
    await ctx.db.exec(`
      CREATE SCHEMA ${n};
      CREATE TABLE ${n}.customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE);
      CREATE TABLE ${n}.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id bigint NOT NULL REFERENCES ${n}.customers(id), status text NOT NULL DEFAULT 'placed');
      CREATE INDEX orders_status_idx ON ${n}.orders (status);
      COMMENT ON TABLE ${n}.orders IS 'raw orders';
      CREATE FUNCTION ${n}.orders_lower_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.status := lower(NEW.status); RETURN NEW; END $$;
      CREATE TRIGGER orders_lower_status BEFORE INSERT OR UPDATE ON ${n}.orders FOR EACH ROW EXECUTE FUNCTION ${n}.orders_lower_status();
      INSERT INTO ${n}.customers (email) VALUES ('a@example.invalid'), ('b@example.invalid');
      ALTER TABLE ${n}.orders ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${n}.orders FORCE ROW LEVEL SECURITY;
      CREATE POLICY orders_placed ON ${n}.orders FOR SELECT TO ${reader(ctx)} USING (status = 'placed');
      GRANT USAGE ON SCHEMA ${n} TO ${reader(ctx)};
      GRANT SELECT ON ${n}.orders TO ${reader(ctx)};`);
  }
}

const comment = (ctx: Ctx) =>
  ctx.db.scalar(
    ctx.dialect === "ch"
      ? `SELECT comment FROM system.tables WHERE database = '${ctx.db.name}' AND name = 'events'`
      : `SELECT obj_description('${ctx.db.name}.orders'::regclass, 'pg_class')`,
  );
const rows = (ctx: Ctx) => ctx.db.count(`SELECT count(*) FROM ${ctx.db.name}.${ctx.dialect === "ch" ? "events" : "customers"}`);

/** One adoption, shared by the parts: whichever runs first makes it. */
interface Adoption {
  done?: { p: Project; doc: InitDoc; before: { comment: string; rows: number } };
  /** Whether init runs with access managed (Postgres). */
  access?: boolean;
}

interface InitDoc {
  status: string;
  migration?: { id: string; checksum: string };
}

/** The hand-made database, adopted with yodel init --from (once). */
async function adopted(ctx: Ctx, s: Adoption): Promise<NonNullable<Adoption["done"]>> {
  if (s.done) return s.done;
  await handMade(ctx);
  const before = { comment: await comment(ctx), rows: await rows(ctx) };
  const p = await Project.create(ctx, { noSource: true });
  if (s.access !== undefined) manageAccess(p, s.access);
  const init = await p.yodel(["init", "--from", p.env, "--json"]);
  const doc = parse<InitDoc>(init);
  hold(init.code === 0 && doc.status === "adopted", `yodel init --from exited ${String(init.code)} (${doc.status})`);
  await p.commit("adopted");
  s.done = { p, doc, before };
  return s.done;
}

/**
 * Postgres access control (#45) is adopted with the tables: orders has
 * row-level security forced on, a policy for a role and grants on the
 * schema and orders, made by hand, and the environment manages access
 * (yodel.config.ts). init --from declares the policy, the row-level
 * security and the grants, names the role as text (a role is the
 * environment's, so it is never declared or created), records them in the
 * baseline, and leaves the server's access as it was.
 * BREAK: access is off in yodel.config.ts, so init adopts the tables alone.
 */
async function accessPart(ctx: Ctx, s: Adoption): Promise<void> {
  const r = reader(ctx);
  await ctx.db.exec(`DO $$ BEGIN CREATE ROLE ${r} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  s.access = !ctx.broken;
  const { p, doc } = await adopted(ctx, s);
  const src = p.read("src/schema.ts");
  for (const want of ["= policy`", "= grant`", "ENABLE ROW LEVEL SECURITY", "FORCE ROW LEVEL SECURITY", `TO ${r}`]) {
    hold(src.includes(want), `yodel init --from did not declare ${want}`);
  }
  hold(!src.includes("= role`"), "yodel init --from declared the role, which is the environment's");
  const baseline = doc.migration ? p.migration(doc.migration.id).steps : [];
  const rules = baseline.map((st) => st.rule ?? "");
  hold(rules.includes("SQLPG296"), `the baseline does not record the grants (SQLPG296): ${[...new Set(rules)].join(", ")}`);
  const on = await accessOnServer(ctx);
  hold(on.rls && on.forced && on.policy && on.usage && on.select && !on.insert, `the server's access changed during the adoption: ${JSON.stringify(on)}`);
}

/**
 * ClickHouse access control (#46) is adopted with the tables: a role with a
 * setting, a user with a password that is granted the role (its default
 * role), a row policy on events for the role, and the role's SELECT, made
 * by hand, with access managed in the environment (yodel.config.ts). init
 * --from declares the role, the user without its password (the
 * environment's), the policy and every grant of each grantee, records them
 * in the baseline, and leaves the server's access as it was.
 * BREAK: access is off in yodel.config.ts, so init adopts the tables alone.
 */
async function chAccessPart(ctx: Ctx, s: Adoption): Promise<void> {
  const { reader: role, svc } = chNames(ctx);
  s.access = !ctx.broken;
  const { p, doc } = await adopted(ctx, s);
  const src = existsSync(p.path("src/access.ts")) ? p.read("src/access.ts") : "";
  for (const want of ["= role`", "= user`", "= policy`", "= grant`", `CREATE ROLE ${role}`, `CREATE USER ${svc}`, "DEFAULT ROLE ${", "ON ${events}"]) {
    hold(src.includes(want), `yodel init --from did not declare ${want} in src/access.ts:\n${src}`);
  }
  hold(!/IDENTIFIED/i.test(src), "yodel init --from declared the user's authentication, which is the environment's");
  const baseline = doc.migration ? p.migration(doc.migration.id).steps : [];
  const rules = baseline.map((st) => st.rule ?? "");
  hold(rules.includes("SQLCH273"), `the baseline does not record the grants (SQLCH273): ${[...new Set(rules)].join(", ")}`);
  const on = await chAccessOnServer(ctx);
  hold(on.role && on.user && on.policy && on.select && on.granted && !on.insert, `the server's access changed during the adoption: ${JSON.stringify(on)}`);
  hold((await ctx.db.scalar(`SELECT auth_type[1] FROM system.users WHERE name = '${svc}'`)) === "sha256_password", "the user's password changed during the adoption");
}

/**
 * An object of a kind yodel cannot declare (#251): the schema holds an
 * operator, which chant's sql lexicon has no declaration for (its import
 * refuses it, INTENTIUS/chant#3911). yodel init --from refuses (exit 4)
 * naming it, and writes nothing, so nothing is left out of an adopted schema
 * in silence. It runs before the shared adoption, on the claim's schema, and
 * drops what it made.
 * BREAK: yodel built to go on past the refusal, adopting the rest without
 * naming the operator.
 */
async function unsupportedPart(ctx: Ctx): Promise<void> {
  const n = ctx.db.name;
  await ctx.db.exec(`CREATE SCHEMA ${n}; CREATE FUNCTION ${n}.same(integer, integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1 = $2'; CREATE OPERATOR ${n}.=== (LEFTARG = integer, RIGHTARG = integer, FUNCTION = ${n}.same)`);
  try {
    const p = await Project.create(ctx, { noSource: true, name: "unsupported" });
    const yodel = ctx.broken ? yodelBuild(ctx, p, "yodel-skips-the-refusal", { file: "init/adopt.js", from: "throw refusal;", to: "void refusal;" }) : undefined;
    if (ctx.broken) ctx.log("BREAK: yodel built to go on past the refusal of an object it cannot declare");
    const args = ["init", "--from", p.env];
    const ran = yodel ? await yodel.ask("", args) : await p.yodel(args);
    hold(ran.code === 4 && ran.err.includes(`operator ${n}.===(integer,integer)`), `yodel init --from exited ${String(ran.code)} without naming the operator ${n}.=== it cannot declare: ${ran.err.trim().split("\n").slice(-4).join("\n")}`);
    hold(p.migrationIds().length === 0, "yodel init --from wrote a migration although it refused");
  } finally {
    // The history too: under BREAK=1 init goes on and records a baseline, which the adoption after this would refuse.
    await ctx.db.exec(`DROP SCHEMA IF EXISTS ${n} CASCADE; DROP SCHEMA IF EXISTS ${ctx.db.history} CASCADE`);
  }
}

/** Every declaration file yodel init --from wrote, as one text. A tag may carry a type argument (`table<"db.t">`). */
const declared = (p: Project): string =>
  readdirSync(p.path("src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => p.read(join("src", f)))
    .join("\n");

/**
 * `yodel init --from <env>` adopts a database made by hand (on Postgres,
 * with a trigger function and a trigger; on ClickHouse, with a dictionary
 * and a function a view calls): it writes the declarations and a
 * baseline migration, records the baseline applied without running it (the objects keep their data and stay as they were),
 * and then yodel plan shows no change and yodel apply has nothing to do.
 * BREAK: one adopted declaration is edited after init (a column's type),
 * so the declared schema no longer matches the server.
 */
async function initPart(ctx: Ctx, s: Adoption): Promise<void> {
  const { p, doc, before } = await adopted(ctx, s);
  hold(doc.migration !== undefined && p.migrationIds().length === 1, "init wrote no baseline migration");
  if (ctx.dialect === "pg") {
    // Functions and triggers are adopted with the tables (#44), so the declared schema holds what the server does.
    const src = declared(p);
    hold(/= func(<[^>]*>)?`/.test(src) && /= trigger(<[^>]*>)?`/.test(src) && src.includes("orders_lower_status"), "yodel init --from did not declare the function and the trigger it found");
  } else {
    // Dictionaries and functions are adopted with the tables (#46).
    const src = declared(p);
    hold(/= dictionary(<[^>]*>)?`/.test(src) && /= func(<[^>]*>)?`/.test(src) && src.includes(chNames(ctx).fn), "yodel init --from did not declare the dictionary and the function it found");
  }

  if (ctx.broken) {
    if (ctx.dialect === "ch") p.edit("src/schema.ts", "kind LowCardinality(String)", "kind String");
    else p.edit("src/schema.ts", "email text NOT NULL", "email varchar(200) NOT NULL");
  }

  // What a team does next: write a migration for any change, then plan. Neither finds anything.
  const next = await p.newMigration("after-adopt");
  hold(next === undefined, `yodel new after init wrote ${String(next)}: the declarations do not match the adopted baseline`);
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ pending?: unknown[]; problems?: unknown[] }>(plan);
  hold(plan.code === 0, `yodel plan after init exited ${String(plan.code)}`);
  hold(planned.pending?.length === 0 && planned.problems?.length === 0, `yodel plan after init shows ${String(planned.pending?.length)} pending and ${String(planned.problems?.length)} problems`);

  // From the server: nothing was sent. The objects are as they were, unmarked, with their data.
  hold((await comment(ctx)) === before.comment, `the adopted table's comment changed from ${JSON.stringify(before.comment)} to ${JSON.stringify(await comment(ctx))}`);
  hold((await rows(ctx)) === before.rows, "the adopted table lost rows");
  {
    const baseline = await ctx.db.count(
      `SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'migration' AND status = 'succeeded' AND note LIKE 'baseline:%' AND checksum = '${doc.migration.checksum}'`,
    );
    const statements = await ctx.db.count(`SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'statement'`);
    hold(baseline === 1 && statements === 0, `the history holds ${String(baseline)} baseline rows and ${String(statements)} statement rows, not one and none`);
    const status = await p.status();
    hold(status.ran.code === 0 && status.doc.pending?.length === 0, `yodel status after init exited ${String(status.ran.code)} with ${String(status.doc.pending?.length)} pending`);
  }
}

/** The second environment's profile in chant.config.ts, with the access the first one has. */
function secondProfile(ctx: Ctx, server: SecondServer, access: boolean): string {
  if (ctx.dialect === "ch") return `{ url: "${server.url}", databases: ["${ctx.db.name}"]${access ? ", access: true" : ""} }`;
  return `{ url: "${server.url}", user: { env: "YODEL_CLAIMS_POSTGRES_USER" }, password: { env: "YODEL_CLAIMS_POSTGRES_PASSWORD" }, schemas: ["${ctx.db.name}"], lockTimeoutMs: 500${access ? ", access: true" : ""} }`;
}

/**
 * `yodel init --baseline <env>` (#115): a second environment that already
 * holds the schema (made by hand the same way, with its data, on a server
 * of its own) takes the project's baseline as applied, through its
 * migrations Op and behind its gate: the run stops at the gate, and once
 * approved records the baseline without running a statement. Then its
 * history holds the one baseline row, yodel status lists the baseline
 * applied, yodel plan shows only the migrations after it pending, and the
 * objects keep their data.
 * BREAK: the second environment differs from the baseline (a column the
 * baseline does not have), and it is refused, naming the difference, with
 * nothing recorded.
 */
async function secondEnvPart(ctx: Ctx, s: Adoption): Promise<void> {
  const { p, doc } = await adopted(ctx, s);
  const baseline = doc.migration?.id ?? "";
  const env = `${ctx.env}-second`;
  const server = await secondServer(ctx, "second");
  try {
    await handMade(ctx, (sql) => server.exec(sql));
    const table = ctx.dialect === "ch" ? "events" : "customers";
    if (ctx.broken) await server.exec(`ALTER TABLE ${ctx.db.name}.${table} ADD COLUMN extra ${ctx.dialect === "ch" ? "String DEFAULT ''" : "text"}`);
    const rowsBefore = await server.scalar(`SELECT count(*) FROM ${ctx.db.name}.${table}`);
    p.edit("chant.config.ts", /profiles: \{\n/, `profiles: {\n      "${env}": ${secondProfile(ctx, server, s.access === true)},\n`);
    p.write("yodel.config.ts", `import { defineConfig } from "@intentius/sql-yodeler";\n\nexport default defineConfig({\n  environments: { ${JSON.stringify(p.env)}: { access: ${String(s.access === true)} }, ${JSON.stringify(env)}: { access: ${String(s.access === true)} } },\n});\n`);
    p.write(`ops/migrate-${env}.op.ts`, p.read(`ops/migrate-${p.env}.op.ts`).replaceAll(p.env, env));
    await p.commit("a second environment");

    const first = await p.yodel(["init", "--baseline", env, "--json"], { timeoutMs: 600_000 });
    hold(first.code === 3, `yodel init --baseline ${env} exited ${String(first.code)}, not 3 at the gate: ${first.err.trim().split("\n").slice(-6).join("\n")}`);
    const gated = parse<{ status: string; approve?: string; chantApprove?: string; planDigest: string }>(first);
    hold(gated.status === "gated" && gated.approve !== undefined, `yodel init --baseline ${env} did not stop at the gate (${gated.status})`);
    const unrecorded = await server.scalar(`SELECT count(*) FROM ${ctx.db.history}.history`).catch(() => "0");
    hold(unrecorded === "0" || unrecorded === "", `the history recorded ${unrecorded} rows before the approval`);
    await p.approve(gated.chantApprove);
    const second = await p.yodel(["init", "--baseline", env, "--json"], { timeoutMs: 600_000 });
    hold(second.code === 0 && parse<{ status: string }>(second).status === "recorded", `yodel init --baseline ${env} after the approval exited ${String(second.code)}`);

    const baselineRows = await server.scalar(
      `SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'migration' AND status = 'succeeded' AND migration_id = '${baseline}' AND note LIKE 'baseline:%' AND plan_digest = '${gated.planDigest}'`,
    );
    const statements = await server.scalar(`SELECT count(*) FROM ${ctx.db.history}.history WHERE kind = 'statement'`);
    hold(baselineRows === "1" && statements === "0", `${env}'s history holds ${baselineRows} baseline rows under the approved digest and ${statements} statement rows, not one and none`);
    hold((await server.scalar(`SELECT count(*) FROM ${ctx.db.name}.${table}`)) === rowsBefore, `${env}'s ${table} lost rows`);
    const status = await p.yodel(["status", env, "--json"]);
    const st = parse<{ applied?: Array<{ id: string }>; pending?: Array<{ id: string }> }>(status);
    hold(st.applied?.map((a) => a.id).join() === baseline, `yodel status ${env} lists ${JSON.stringify(st.applied?.map((a) => a.id))} applied, not the baseline alone`);
    // A part before may have left a migration after the baseline (init's break writes one): it is pending here as anywhere.
    const after = p.migrationIds().filter((id) => id !== baseline);
    hold((st.pending ?? []).map((m) => m.id).join() === after.join(), `yodel status ${env} lists ${JSON.stringify(st.pending?.map((m) => m.id))} pending, not ${JSON.stringify(after)}`);
  } finally {
    await server.close();
  }
}

/**
 * The access part first (it decides whether init manages access): Postgres
 * and ClickHouse each have their own. Then the adoption's own checks.
 */
const parts: ReadonlyArray<PartEntry<Adoption>> = [
  // Before the shared adoption: it makes and drops the claim's schema itself.
  ["unsupported", unsupportedPart, ["pg"]],
  ["access", accessPart, ["pg"]],
  ["ch-access", chAccessPart, ["ch"]],
  ["init", initPart],
  // The baseline is the same on both dialects.
  ["second-env", secondEnvPart, ["pg"]],
];

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, {}, parts);
}

export const adopt: Claim = {
  name: "adopt",
  says: "yodel init --from adopts a live database without touching it, and yodel plan then shows no change; on Postgres its policies, row-level security and grants too, on ClickHouse its dictionaries, functions, roles, users, row policies and grants; it refuses a database holding an object of a kind it cannot declare, naming it; yodel init --baseline records the baseline, behind the gate, in a second environment that holds the same schema, and refuses one that differs",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
  partDialects: partDialects(parts),
};
