import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hold, partDialects, partNames, runParts, type Claim, type Ctx, type PartEntry } from "../../lib/claim.js";
import { parse, Project } from "../../lib/project.js";
import { declareRoutines, insertedStatus, replaceFunctionByHand, routinesOnServer } from "../../lib/routines.js";
import { addColumn, mainTable } from "../../lib/schema.js";
import { accessOnServer, declareAccess, manageAccess, reader } from "../../lib/access.js";
import { chAccessOnServer, chNames, declareChAccess, declareDictionary, declareFunction, dictionaryLifetime, replaceDictionaryByHand, scaled } from "../../lib/clickhouse-objects.js";

/** A declarative project (no migrations/) applied once behind its ApplyOp's gate. */
export async function declared(ctx: Ctx): Promise<Project> {
  const p = await Project.create(ctx, { ops: "declarative" });
  // Setup for the claims built on it: a step that goes wrong here is an error, never a catch.
  const first = await p.apply();
  if (first.ran.code !== 3 || first.doc.status !== "gated") throw new Error(`yodel apply did not stop at the ApplyOp's gate (exit ${String(first.ran.code)})`);
  if (await ctx.db.tableExists(mainTable(ctx))) throw new Error("the table exists before the approval");
  await p.approve(first.doc.chantApprove);
  const applied = await p.apply();
  if (applied.ran.code !== 0 || !(await ctx.db.tableExists(mainTable(ctx)))) throw new Error(`the approved plan did not apply (exit ${String(applied.ran.code)})`);
  return p;
}

/**
 * The declarative path: yodel plan shows the change from the live server
 * to the declared schema, yodel apply makes it behind the ApplyOp's
 * plan-bound gate, and the plan is then empty.
 * BREAK: the source changes again between the approval and the apply, so
 * the approval no longer covers the plan and the column is not added.
 */
async function column(ctx: Ctx, { p }: Declarative): Promise<void> {
  addColumn(p, "note");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ changes: unknown[] }>(plan);
  hold(plan.code === 0 && planned.changes.length === 1, `yodel plan shows ${String(planned.changes.length)} changes for one added column`);
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.chantApprove);
  if (ctx.broken) addColumn(p, "extra");
  await p.apply();
  hold(await ctx.db.columnExists(mainTable(ctx), "note"), "the approved column is not on the server");
  const after = await p.yodel(["plan", p.env, "--json"]);
  hold(after.code === 0 && parse<{ changes: unknown[] }>(after).changes.length === 0, "yodel plan after the apply is not empty");
}

/**
 * Postgres functions, procedures and triggers (#44): a trigger function, a
 * trigger on the existing orders table that runs it, and a procedure are
 * planned with their classes (the trigger as SQLPG283, the lock it takes on
 * a table that exists) and applied behind the gate; the trigger then fires,
 * and the plan is empty.
 * BREAK: the function is replaced by hand after the apply, so the server
 * no longer holds what is declared and the plan is not empty.
 */
async function routines(ctx: Ctx, { p }: Declarative): Promise<void> {
  declareRoutines(p);
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const rules = parse<{ changes: Array<{ object: string; rule: string }> }>(plan).changes.map((c) => `${c.object.split(" ")[0] ?? ""} ${c.rule}`);
  for (const want of ["lowerStatus SQLPG200", "archiveOrders SQLPG200", "ordersLowerStatus SQLPG283"]) {
    hold(rules.includes(want), `yodel plan does not show ${want}: ${rules.join(", ")}`);
  }
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.chantApprove);
  const applied = await p.apply();
  hold(applied.ran.code === 0, `the approved routines did not apply (exit ${String(applied.ran.code)})`);
  const on = await routinesOnServer(ctx);
  hold(on.fn && on.proc && on.trigger, `on the server: function ${String(on.fn)}, procedure ${String(on.proc)}, trigger ${String(on.trigger)}`);
  hold((await insertedStatus(ctx)) === "shipped", "the trigger did not lower-case an inserted status");
  if (ctx.broken) await replaceFunctionByHand(ctx);
  const after = await p.yodel(["plan", p.env, "--json"]);
  const left = parse<{ changes: Array<{ object: string }> }>(after).changes.map((c) => c.object);
  hold(after.code === 0 && left.length === 0, `yodel plan after the routines applied is not empty: ${left.join(", ")}`);
}

/** A declarative plan's access section (#45), as `yodel plan --json` prints it. */
interface AccessPlan {
  changes: Array<{ object: string; rule: string; class: string }>;
  access?: { managed: boolean; source: string; changes: Array<{ object: string; rule: string; class: string; field: string; byHand?: true }> };
}

/** yodel apply, approved at its gate, yodel apply again: the second apply's exit code. */
async function approvedApply(p: Project): Promise<number> {
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)}): ${gated.ran.err.slice(-600)}`);
  await p.approve(gated.doc.chantApprove);
  return (await p.apply()).ran.code;
}

/**
 * Postgres access control (#45), managed in the environment
 * (yodel.config.ts and the chant profile both say access: true): a role,
 * row-level security forced on orders, a policy for the role and two grants
 * are planned with their rules and classes, and applied behind the gate. A
 * privilege then granted by hand on orders is drift: yodel plan calls it out
 * as revoked by the next apply, and the approved apply revokes it.
 * BREAK: access is turned off for the environment before the grant is made
 * by hand, so the plan does not read the server's privileges and the role
 * keeps it.
 */
async function access(ctx: Ctx, { p }: Declarative): Promise<void> {
  manageAccess(p);
  declareAccess(p);
  await p.commit("access control");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<AccessPlan>(plan);
  const shown = (planned.access?.changes ?? []).map((c) => `${c.rule} ${c.class} ${c.field}`);
  hold(plan.code === 0 && planned.access?.managed === true, `yodel plan does not manage access in ${p.env}: ${JSON.stringify(planned.access)}`);
  for (const want of ["SQLPG200 create role", "SQLPG290 metadata policy", "SQLPG296 metadata privileges"]) {
    hold(shown.includes(want), `yodel plan's access section does not show ${want}: ${shown.join(", ")}`);
  }
  hold(planned.changes.some((c) => c.rule === "SQLPG293"), `yodel plan does not turn on orders' row-level security: ${planned.changes.map((c) => c.rule).join(", ")}`);
  hold((await approvedApply(p)) === 0, "the approved access control did not apply");
  const on = await accessOnServer(ctx);
  hold(on.rls && on.forced && on.policy && on.usage && on.select && !on.insert, `on the server after the apply: ${JSON.stringify(on)}`);

  if (ctx.broken) {
    manageAccess(p, false);
    await p.commit("access off");
  }
  await ctx.db.exec(`GRANT INSERT ON ${ctx.db.name}.orders TO ${reader(ctx)}`);
  const drift = await p.yodel(["plan", p.env, "--json"]);
  const byHand = (parse<AccessPlan>(drift).access?.changes ?? []).filter((c) => c.byHand);
  hold(byHand.length === 1 && byHand[0]?.rule === "SQLPG297" && byHand[0].object.includes("orders"), `yodel plan does not call out the grant made by hand as revoked: ${JSON.stringify(parse<AccessPlan>(drift).access)}`);
  const text = await p.yodel(["plan", p.env]);
  hold(/Revoked by this apply, though no declaration revokes it[^\n]*\n\s+relation \S+orders FROM \S+: insert\n/.test(text.out), `yodel plan's text does not call out the revoke:\n${text.out.slice(-1200)}`);
  await approvedApply(p);
  const after = await accessOnServer(ctx);
  hold(!after.insert && after.select, `the grant made by hand was not revoked, or the declared one went with it: ${JSON.stringify(after)}`);
  const clean = await p.yodel(["plan", p.env, "--json"]);
  hold(clean.code === 0 && parse<AccessPlan>(clean).changes.length === 0, `yodel plan after the revoke is not empty: ${clean.out.slice(0, 600)}`);
}

/** What `yodel plan --json` lists: each change's object and rule. */
const planned = (out: AccessPlan): string[] => out.changes.map((c) => `${c.object.split(" ")[0] ?? ""} ${c.rule}`);

/**
 * A ClickHouse dictionary (#46) over the fixture's daily table: created
 * (SQLCH200) behind the gate, answering dictGet; a new lifetime then plans
 * as SQLCH245 and applies as one CREATE OR REPLACE, and the plan is empty.
 * BREAK: the dictionary is replaced by hand after the apply, so the server
 * no longer holds what is declared and the plan is not empty.
 */
async function dictionaryPart(ctx: Ctx, { p }: Declarative): Promise<void> {
  declareDictionary(p, 300);
  const plan = await p.yodel(["plan", p.env, "--json"]);
  hold(plan.code === 0 && planned(parse<AccessPlan>(plan)).includes("dailyN SQLCH200"), `yodel plan does not create the dictionary: ${plan.out.slice(0, 600)}`);
  hold((await approvedApply(p)) === 0, "the approved dictionary did not apply");
  await ctx.db.exec(`INSERT INTO ${ctx.db.name}.daily (day, n) VALUES ('2026-10-01', 7)`);
  hold((await ctx.db.scalar(`SELECT dictGet('${ctx.db.name}.${chNames(ctx).dict}', 'n', tuple(toDate('2026-10-01')))`)) === "7", "dictGet does not read daily through the dictionary");

  declareDictionary(p, 600);
  const changed = await p.yodel(["plan", p.env, "--json"]);
  const rules = planned(parse<AccessPlan>(changed));
  hold(changed.code === 0 && rules.length === 1 && rules[0] === "dailyN SQLCH245", `yodel plan does not show the new lifetime as SQLCH245: ${rules.join(", ")}`);
  hold((await approvedApply(p)) === 0, "the dictionary's new lifetime did not apply");
  hold((await dictionaryLifetime(ctx)) === "600", `the dictionary's lifetime on the server is ${await dictionaryLifetime(ctx)}, not 600`);
  if (ctx.broken) await replaceDictionaryByHand(ctx);
  const after = await p.yodel(["plan", p.env, "--json"]);
  const left = planned(parse<AccessPlan>(after));
  hold(after.code === 0 && left.length === 0, `yodel plan after the dictionary applied is not empty: ${left.join(", ")}`);
}

/**
 * A ClickHouse SQL function (#46): created (SQLCH200) behind the gate and
 * callable; a new lambda then plans as SQLCH260 and applies as CREATE OR
 * REPLACE FUNCTION, though the server prints it differently, and the plan is
 * empty.
 * BREAK: the function is replaced by hand after the apply, so the plan is
 * not empty.
 */
async function functionPart(ctx: Ctx, { p }: Declarative): Promise<void> {
  declareFunction(p, "x * k");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  hold(plan.code === 0 && planned(parse<AccessPlan>(plan)).includes("scale SQLCH200"), `yodel plan does not create the function: ${plan.out.slice(0, 600)}`);
  hold((await approvedApply(p)) === 0, "the approved function did not apply");
  hold((await scaled(ctx)) === "6", `the function gives ${await scaled(ctx)} for (2, 3), not 6`);

  declareFunction(p, "x * k + 1");
  const changed = await p.yodel(["plan", p.env, "--json"]);
  const rules = planned(parse<AccessPlan>(changed));
  hold(changed.code === 0 && rules.length === 1 && rules[0] === "scale SQLCH260", `yodel plan does not show the new lambda as SQLCH260: ${rules.join(", ")}`);
  hold((await approvedApply(p)) === 0, "the function's new lambda did not apply");
  hold((await scaled(ctx)) === "7", `the function gives ${await scaled(ctx)} for (2, 3) after the change, not 7`);
  if (ctx.broken) await ctx.db.exec(`CREATE OR REPLACE FUNCTION ${chNames(ctx).fn} AS (x, k) -> x - k`);
  const after = await p.yodel(["plan", p.env, "--json"]);
  const left = planned(parse<AccessPlan>(after));
  hold(after.code === 0 && left.length === 0, `yodel plan after the function applied is not empty: ${left.join(", ")}`);
}

/**
 * ClickHouse access control (#46), managed in the environment
 * (yodel.config.ts's access: true): a role, a user it is granted to, a row
 * policy on events and the role's SELECT are planned under the access
 * section and applied behind the gate. A privilege then granted to the role
 * by hand is drift: yodel drift reports it, yodel plan calls it out as
 * revoked by the next apply, and the approved apply revokes it.
 * BREAK: access is turned off for the environment before the grant is made
 * by hand, so chant reads no access there and nothing calls the grant out.
 */
async function chAccess(ctx: Ctx, { p }: Declarative): Promise<void> {
  const { reader: role } = chNames(ctx);
  manageAccess(p);
  declareChAccess(p);
  await p.commit("access control");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const doc = parse<AccessPlan>(plan);
  const shown = (doc.access?.changes ?? []).map((c) => `${c.object.split(" ")[0] ?? ""} ${c.rule}`);
  hold(plan.code === 0 && doc.access?.managed === true, `yodel plan does not manage access in ${p.env}: ${JSON.stringify(doc.access)}`);
  for (const want of ["reader SQLCH200", "svc SQLCH200", "clicksOnly SQLCH200", `grants SQLCH200`]) {
    hold(shown.includes(want), `yodel plan's access section does not show ${want}: ${shown.join(", ")}`);
  }
  hold((await approvedApply(p)) === 0, "the approved access control did not apply");
  const on = await chAccessOnServer(ctx);
  hold(on.role && on.user && on.policy && on.select && on.granted && !on.insert, `on the server after the apply: ${JSON.stringify(on)}`);

  if (ctx.broken) {
    manageAccess(p, false);
    await p.commit("access off");
  }
  await ctx.db.exec(`GRANT INSERT ON ${ctx.db.name}.events TO ${role}`);
  const drift = await p.yodel(["drift", p.env, "--json"]);
  hold(drift.code === 2 && drift.out.includes(`grants ${role}`), `yodel drift does not report the grant made by hand (exit ${String(drift.code)}): ${(drift.out || drift.err).slice(0, 600)}`);
  const again = await p.yodel(["plan", p.env, "--json"]);
  hold(again.code === 0, `yodel plan exited ${String(again.code)}: ${again.err.slice(-600)}`);
  const byHand = (parse<AccessPlan>(again).access?.changes ?? []).filter((c) => c.byHand);
  hold(byHand.length === 1 && byHand[0]?.rule === "SQLCH274", `yodel plan does not call out the grant made by hand as revoked: ${JSON.stringify(parse<AccessPlan>(again).access)}`);
  const text = await p.yodel(["plan", p.env]);
  hold(new RegExp(`Revoked by this apply, though no declaration revokes it[^\\n]*\\n\\s+INSERT ON \\S+events FROM ${role}\\n`).test(text.out), `yodel plan's text does not call out the revoke:\n${text.out.slice(-1200)}`);
  hold((await approvedApply(p)) === 0, "the approved revoke did not apply");
  const after = await chAccessOnServer(ctx);
  hold(!after.insert && after.select, `the grant made by hand was not revoked, or the declared one went with it: ${JSON.stringify(after)}`);
  const clean = await p.yodel(["plan", p.env, "--json"]);
  hold(clean.code === 0 && parse<AccessPlan>(clean).changes.length === 0, `yodel plan after the revoke is not empty: ${clean.out.slice(0, 600)}`);
}

/** The ORM's DDL, scenarios/fixtures/<dialect>/orm/schema.sql: customers and invoices. */
const ormDdl = (ctx: Ctx): string => readFileSync(fileURLToPath(new URL(`../../fixtures/${ctx.dialect === "ch" ? "clickhouse" : "postgres"}/orm/schema.sql`, import.meta.url)), "utf8");

/** A column added to the ORM's customers model, as the ORM would print it. */
function addOrmColumn(p: Project, column: string): void {
  const ch = p.ctx.dialect === "ch";
  // After the created_at column, the last of customers' columns.
  const at = ch ? "    created_at DateTime DEFAULT now()" : `    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,`;
  p.edit("db/orm.sql", at, ch ? `${at},\n    ${column} String DEFAULT ''` : `${at}\n    "${column}" TEXT,`);
}

/**
 * An ORM-exported schema (#67): the project's yodel.config.ts declares a DDL
 * source, a command printing the DDL an ORM would (the fixture's
 * orm/schema.sql; no ORM is installed). yodel reads it into declarations
 * beside src/, so the first apply creates the ORM's tables behind the gate,
 * a model change (a column added to customers) is one change in yodel plan
 * and is applied once approved, and the plan is then empty.
 * It runs on its own database: the one the src/ parts used is emptied first.
 * BREAK: the ORM's DDL changes again between the approval and the apply,
 * so the approval no longer covers the plan and the column is not added.
 */
async function orm(ctx: Ctx): Promise<void> {
  await ctx.db.reset();
  const p = await Project.create(ctx, { ops: "declarative", name: "orm" });
  // Marked so a build of the project root (the ApplyOp's diff) does not read the DDL as well as the declarations yodel writes from it.
  p.write("db/orm.sql", `-- chant-discovery-skip: yodel reads this into src/orm.generated.ts\n${ormDdl(ctx)}`);
  p.write(
    "yodel.config.ts",
    `import { defineConfig } from "@intentius/sql-yodeler";\n\nexport default defineConfig({\n  sources: { orm: { command: "cat db/orm.sql", schema: "${ctx.db.name}" } },\n});\n`,
  );
  await p.commit("an ORM's schema as a DDL source");
  const first = await p.apply();
  if (first.ran.code !== 3) throw new Error(`yodel apply did not stop at the ApplyOp's gate (exit ${String(first.ran.code)}): ${first.ran.err.slice(-600)}`);
  await p.commit("the ORM's declarations");
  await p.approve(first.doc.chantApprove);
  const created = await p.apply();
  if (created.ran.code !== 0 || !(await ctx.db.tableExists("invoices"))) throw new Error(`the ORM's tables were not created (exit ${String(created.ran.code)})`);

  addOrmColumn(p, "phone");
  const plan = await p.yodel(["plan", p.env, "--json"]);
  const planned = parse<{ changes: Array<{ object: string }> }>(plan);
  hold(plan.code === 0 && planned.changes.length === 1 && planned.changes.every((c) => c.object.includes("customers")), `yodel plan shows ${JSON.stringify(planned.changes)} for one column added to the ORM's customers model`);
  const gated = await p.apply();
  if (gated.ran.code !== 3) throw new Error(`yodel apply did not stop at the gate (exit ${String(gated.ran.code)})`);
  await p.approve(gated.doc.chantApprove);
  if (ctx.broken) addOrmColumn(p, "fax");
  await p.apply();
  hold(await ctx.db.columnExists("customers", "phone"), "the approved column of the ORM's model is not on the server");
  const after = await p.yodel(["plan", p.env, "--json"]);
  hold(after.code === 0 && parse<{ changes: unknown[] }>(after).changes.length === 0, `yodel plan after the apply is not empty: ${after.out.slice(0, 600)}`);
}

/** A policy that refuses destructive changes, as yodel.config.ts declares it. */
const NO_DROPS = `import { defineConfig } from "@intentius/sql-yodeler";\n\nexport default defineConfig({\n  policy: { rules: [{ id: "no-drops", refuse: { destructive: true } }] },\n});\n`;

/**
 * The declarative path's review (#249). yodel.config.ts at the base commit
 * declares a policy that refuses destructive changes, and the change drops
 * a column (ClickHouse: events.id; Postgres: orders.amount). yodel lint,
 * offline, passes; yodel lint --env flags the drop destructive (exit 3);
 * yodel plan --format markdown, what --comment posts, carries the plan
 * comment's marker, the finding, the denied rule and the override command;
 * and yodel apply refuses before the gate (exit 4, status denied), so the
 * column is still on the server. The schema and config are put back after.
 * BREAK: the policy arrives with the change rather than before it, so the
 * base commit has none, nothing denies, and yodel apply goes on to the gate.
 */
async function review(ctx: Ctx, { p }: Declarative): Promise<void> {
  const [table, column] = ctx.dialect === "ch" ? ["events", "id"] : ["orders", "amount"];
  const before = p.read("src/schema.ts");
  if (!ctx.broken) {
    p.write("yodel.config.ts", NO_DROPS);
    await p.commit("a policy that refuses drops");
  }
  if (ctx.dialect === "ch") p.edit("src/schema.ts", "    id   UInt64,\n", "");
  else p.edit("src/schema.ts", /,\n\s+amount numeric\(12, 2\) NOT NULL/, "");
  if (ctx.broken) p.write("yodel.config.ts", NO_DROPS);
  await p.commit(`drop ${table}.${column}`);
  try {
    const offline = await p.yodel(["lint", "--json"]);
    hold(offline.code === 0 && parse<{ declarative?: boolean }>(offline).declarative === true, `yodel lint, offline, exited ${String(offline.code)} on the declared schema: ${offline.out.slice(0, 600)}`);
    const linted = await p.yodel(["lint", "--env", p.env, "--json"]);
    const findings = parse<{ findings: Array<{ rule: string; message: string }> }>(linted).findings;
    hold(linted.code === 3 && findings.some((f) => f.rule === "destructive" && f.message.includes(column)), `yodel lint --env exited ${String(linted.code)} with no destructive finding on ${table}.${column}: ${JSON.stringify(findings)}`);
    const md = await p.yodel(["plan", p.env, "--format", "markdown"]);
    for (const want of [`<!-- yodel:plan env=${p.env} -->`, "| **error** | `destructive` |", "| `no-drops` | **denied** |", `yodel override ${p.env} --rule no-drops`]) {
      hold(md.out.includes(want), `the plan comment does not carry ${want}:\n${md.out.slice(0, 1500)}`);
    }
    const applied = await p.yodel(["apply", p.env, "--json"]);
    const status = parse<{ status?: string }>(applied).status;
    hold(applied.code === 4 && status === "denied", `yodel apply exited ${String(applied.code)} (${String(status)}) on a plan the policy at base denies`);
    hold(await ctx.db.columnExists(table, column), `${table}.${column} is gone from the server after a denied apply`);
  } finally {
    p.write("src/schema.ts", before);
    rmSync(p.path("yodel.config.ts"), { force: true });
    await p.commit("the schema and config put back");
  }
}

/** The project the src/ parts run on: declarative, applied once. */
interface Declarative {
  p: Project;
}

/**
 * The parts, in order: the src/ declarations, a column added, on Postgres
 * the routines (#44) and access control (#45), and on ClickHouse a
 * dictionary, a function and access control (#46), and the review a pull
 * request gets (#249), on one project; then an ORM's DDL (#67) on a project
 * of its own.
 */
const parts: ReadonlyArray<PartEntry<Declarative>> = [
  ["column", column],
  ["routines", routines, ["pg"]],
  ["access", access, ["pg"]],
  ["dictionary", dictionaryPart, ["ch"]],
  ["function", functionPart, ["ch"]],
  ["ch-access", chAccess, ["ch"]],
  ["review", review],
  ["orm", orm],
];

async function body(ctx: Ctx): Promise<void> {
  await runParts(ctx, { p: await declared(ctx) }, parts);
}

export const declarative: Claim = {
  name: "declarative",
  says: "the declarative path: yodel plan shows the change against the live server and yodel apply makes it behind the plan-bound gate, for src/ declarations (on Postgres, functions, procedures and triggers, and access control: a role, a policy and grants, with a grant made by hand revoked; on ClickHouse, a dictionary, a function, and access control: a role, a user, a row policy and grants, with a grant made by hand revoked) and for an ORM's exported DDL; a pull request on that path gets lint over the planned changes and the plan comment with them, and a policy rule at the base commit that denies the plan refuses yodel apply before the gate",
  dialects: { ch: body, pg: body },
  parts: partNames(parts),
  partDialects: partDialects(parts),
};
