/**
 * ClickHouse access control adopted by `yodel init --from` (#46), where the
 * environment manages access: chant's ClickHouse import writes databases,
 * tables, views, dictionaries and functions, and no user, role, row policy,
 * quota, settings profile or grant, so yodel reads those itself and writes
 * them as `user`, `role`, `policy`, `quota`, `settingsProfile` and `grant`
 * declarations in `access.ts`, beside the import's `schema.ts`.
 *
 * What is adopted, read from the server's catalog:
 *
 * - every row policy on a table in the profile's databases;
 * - the grantees: each user or role holding a privilege in those databases,
 *   each role a policy applies to, and each user or role those roles are
 *   granted to. The `default` user is the server's own and is left out;
 * - every quota and settings profile made with SQL (INTENTIUS/chant#3911);
 *   those in the server's users.xml are the server's own and are left out;
 * - for each grantee, its `CREATE USER` or `CREATE ROLE` and all of its
 *   grants (`SHOW GRANTS FOR`), not only those in the databases: chant
 *   compares a grantee's grants as a whole and revokes what is not
 *   declared, so a partial list would plan revokes.
 *
 * A user's authentication is the environment's: its `IDENTIFIED` clause is
 * left out, and chant then compares the user without it and never creates
 * or changes its password. A grantee with a partial revoke (`REVOKE` in
 * `SHOW GRANTS`) cannot be declared, since a declaration holds no `REVOKE`:
 * it is left out with a warning, and its grants with it.
 *
 * A table the import declared, or a user, role or settings profile adopted
 * here, is interpolated where a statement names it (`ON ${events}`,
 * `TO ${reader}`, `SETTINGS PROFILE ${analysts}`, `SETTINGS INHERIT ${base}`),
 * so the declarations carry their dependencies and a baseline creates them
 * in order. `access.ts` lists each declaration after the ones it
 * interpolates. A settings profile or quota assigned `TO` a user who names
 * that profile in `SETTINGS PROFILE` would make each wait on the other: its
 * `TO` keeps that name as text, with a warning.
 */

import type { GeneratedFile } from "@intentius/chant/import/generator";
import type { TemplateIR } from "@intentius/chant/import/parser";
import type { Environment, Project } from "../project.js";

/** What {@link clickhouseAccessDeclarations} adopts. */
export interface AdoptedAccess {
  /** `access.ts`, or none when there is nothing to adopt. */
  file?: GeneratedFile;
  /** The objects adopted, as `<kind> <name>` lines for people. */
  objects: string[];
  warnings: string[];
}

interface Statement {
  kind: "user" | "role" | "policy" | "quota" | "settingsProfile" | "grant";
  exportName: string;
  /** The object's own name, never interpolated in its own statement. */
  own?: string;
  sql: string;
}

const KIND_LABEL: Record<Exclude<Statement["kind"], "grant">, string> = { user: "User", role: "Role", policy: "RowPolicy", quota: "Quota", settingsProfile: "SettingsProfile" };

const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const ident = (s: string) => `\`${s.replace(/`/g, "``")}\``;
const list = (xs: readonly string[]) => xs.map(quote).join(", ");

const JS_RESERVED = new Set("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(" "));

function camel(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const s = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() : w.charAt(0).toUpperCase()) + w.slice(1)).join("") || "object";
  return /^[0-9]/.test(s) ? `a${s}` : s;
}

/** `CREATE USER u IDENTIFIED WITH sha256_password HOST ...` without its authentication, which is the environment's. */
export function withoutAuthentication(sql: string): string {
  return sql
    .replace(/\s+NOT\s+IDENTIFIED\b/i, "")
    .replace(/\s+IDENTIFIED\s+(?:WITH\s+\w+)?(?:\s+BY\s+'(?:[^'\\]|\\.)*')?(?:\s+SALT\s+'(?:[^'\\]|\\.)*')?/i, "");
}

type Token = { kind: "string" | "ident" | "other"; text: string; name?: string };

/** The statement's tokens: quoted strings, identifiers (bare or backquoted, with `name` unquoted), and the rest. */
function tokens(sql: string): Token[] {
  const out: Token[] = [];
  const re = /('(?:[^'\\]|\\.)*')|(`(?:[^`]|``)*`)|([A-Za-z_][A-Za-z0-9_]*)|(\s+|.)/gs;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    if (m[1] !== undefined) out.push({ kind: "string", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "ident", text: m[2], name: m[2].slice(1, -1).replace(/``/g, "`") });
    else if (m[3] !== undefined) out.push({ kind: "ident", text: m[3], name: m[3] });
    else out.push({ kind: "other", text: m[4] ?? "" });
  }
  return out;
}

/** `text` escaped for a template literal. */
const literal = (text: string) => text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");

/**
 * The statement as a template body: `db.table` of a declared table as its
 * export, and a principal as its export where the statement names it as a
 * grantee, a granted role or a default role (anywhere in a `GRANT`, after
 * `TO` in a row policy, after `DEFAULT ROLE` in a user). Strings and the
 * object's own name stay as they are.
 */
export function templateOf(
  s: Pick<Statement, "kind" | "own" | "sql">,
  tables: ReadonlyMap<string, string>,
  principals: ReadonlyMap<string, string>,
  profiles: ReadonlyMap<string, string> = new Map(),
): { body: string; refs: Set<string> } {
  const t = tokens(s.sql);
  const refs = new Set<string>();
  let body = "";
  let ownSeen = false;
  let zone = s.kind === "grant";
  // The next name is a settings profile: after a user's, role's or profile's `SETTINGS PROFILE`, or `SETTINGS INHERIT`.
  let profileNext = false;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (tok === undefined) break;
    if (tok.kind === "ident") {
      const word = tok.text.toUpperCase();
      if (profileNext) {
        profileNext = false;
        const exp = tok.name !== undefined ? profiles.get(tok.name) : undefined;
        if (exp) {
          body += `\${${exp}}`;
          refs.add(exp);
          continue;
        }
      }
      // `CREATE SETTINGS PROFILE <own>` names the profile itself, not one it uses.
      if (word === "INHERIT" || (word === "PROFILE" && t[i - 2]?.text.toUpperCase() === "SETTINGS" && !/^(CREATE|ALTER)$/i.test(t[i - 4]?.text ?? ""))) profileNext = true;
      if ((s.kind === "policy" || s.kind === "quota" || s.kind === "settingsProfile") && word === "TO") zone = true;
      if (s.kind === "user" && word === "DEFAULT" && t[i + 2]?.text.toUpperCase() === "ROLE") zone = true;
      if (s.kind === "user" && zone && ["SETTINGS", "GRANTEES", "HOST", "VALID", "IN"].includes(word)) zone = false;
      // db.table
      const next = t[i + 2];
      if (t[i + 1]?.text === "." && next?.kind === "ident") {
        const exp = tables.get(`${tok.name ?? ""}.${next.name ?? ""}`);
        if (exp) {
          body += `\${${exp}}`;
          refs.add(exp);
          i += 2;
          continue;
        }
      }
      if (!ownSeen && s.own !== undefined && tok.name === s.own) {
        ownSeen = true;
        body += literal(tok.text);
        continue;
      }
      const exp = zone && tok.name !== undefined ? principals.get(tok.name) : undefined;
      if (exp && t[i - 1]?.text !== ".") {
        body += `\${${exp}}`;
        refs.add(exp);
        continue;
      }
    }
    body += literal(tok.text);
  }
  return { body, refs };
}

type Body = { s: Statement; body: string; refs: Set<string> };

/**
 * `bodies` with each after the ones it interpolates, in their order
 * otherwise. A cycle runs through a settings profile's or quota's `TO` (a
 * user naming a profile assigned to it): `retemplate` renders that
 * statement again without the principal it points back to, and a warning
 * says so.
 */
export function ordered(bodies: readonly Body[], retemplate: (b: Body, cut: string) => Body, warnings: string[]): Body[] {
  const byExport = new Map(bodies.map((b) => [b.s.exportName, b]));
  // A profile assigned TO a user or role that names it: the profile's TO keeps that name as text.
  for (const [name, b] of byExport) {
    const kind = b.s.kind;
    if (kind !== "settingsProfile" && kind !== "quota") continue;
    let cur = b;
    for (const dep of [...cur.refs]) {
      if (!byExport.get(dep)?.refs.has(name)) continue;
      cur = retemplate(cur, dep);
      warnings.push(`${KIND_LABEL[kind]} ${cur.s.own ?? name} is assigned TO ${dep}, which names it in SETTINGS PROFILE; its TO keeps ${dep} as text, so a baseline replayed into a fresh server needs ${dep} created first`);
    }
    byExport.set(name, cur);
  }
  const out: Body[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    const b = byExport.get(name);
    if (done.has(name) || b === undefined) return;
    if (visiting.has(name)) throw new Error(`access.ts: ${name} names a declaration that names it back`);
    visiting.add(name);
    for (const dep of b.refs) visit(dep);
    visiting.delete(name);
    done.add(name);
    out.push(b);
  };
  for (const b of bodies) visit(b.s.exportName);
  return out;
}

/** The users, roles, row policies, quotas, settings profiles and grants to adopt from `env`, as `access.ts`; see the module comment. */
export async function clickhouseAccessDeclarations(project: Project, env: Environment, ir: TemplateIR, processEnv: NodeJS.ProcessEnv): Promise<AdoptedAccess> {
  const { bindClickHouse } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const { clickhouseQuery } = await import("@intentius/chant-lexicon-sql/clickhouse/http");
  const target = await bindClickHouse({ environment: env.name, config: project.config, cwd: project.dir, env: processEnv });
  const q = <T>(sql: string) => clickhouseQuery<T>(target.endpoint, sql);
  const first = async (sql: string) => Object.values((await q<Record<string, string>>(sql))[0] ?? {})[0] ?? "";
  const databases = target.databases ?? [];
  const warnings: string[] = [];
  if (databases.length === 0) return { objects: [], warnings };

  const policies = await q<{ name: string; database: string; table: string; apply_to_list: string[] }>(
    `SELECT short_name AS name, database, table, apply_to_list FROM system.row_policies WHERE database IN (${list(databases)}) ORDER BY database, table, name`,
  );
  const holders = await q<{ user_name: string | null; role_name: string | null }>(`SELECT DISTINCT user_name, role_name FROM system.grants WHERE database IN (${list(databases)})`);
  const named = new Set<string>([...holders.flatMap((h) => [h.user_name, h.role_name]).filter((n): n is string => !!n), ...policies.flatMap((p) => p.apply_to_list)]);
  const allRoles = new Set((await q<{ name: string }>("SELECT name FROM system.roles")).map((r) => r.name));
  const allUsers = new Set((await q<{ name: string }>("SELECT name FROM system.users")).map((r) => r.name));
  const roles = new Set([...named].filter((n) => allRoles.has(n)));
  const users = new Set([...named].filter((n) => allUsers.has(n) && n !== "default"));
  if (roles.size > 0) {
    for (const g of await q<{ user_name: string | null; role_name: string | null }>(`SELECT user_name, role_name FROM system.role_grants WHERE granted_role_name IN (${list([...roles])})`)) {
      if (g.user_name && g.user_name !== "default") users.add(g.user_name);
      if (g.role_name) roles.add(g.role_name);
    }
  }

  // Each grantee's grants whole; one with a partial revoke cannot be declared.
  const grants = new Map<string, string[]>();
  for (const name of [...[...roles].sort(), ...[...users].sort()]) {
    const lines = (await q<Record<string, string>>(`SHOW GRANTS FOR ${ident(name)}`)).map((r) => Object.values(r)[0] ?? "");
    if (lines.some((l) => /^\s*REVOKE\b/i.test(l))) {
      warnings.push(`${roles.has(name) ? "role" : "user"} ${name} has a partial revoke (${lines.find((l) => /^\s*REVOKE\b/i.test(l)) ?? ""}), which a grant declaration cannot hold; left out, with its grants`);
      roles.delete(name);
      users.delete(name);
      continue;
    }
    grants.set(name, lines.filter((l) => /^\s*GRANT\b/i.test(l)));
  }

  const used = new Set(ir.resources.map((r) => r.logicalId));
  const exportFor = (base: string): string => {
    let b = camel(base);
    if (JS_RESERVED.has(b)) b = `${b}Access`;
    let name = b;
    for (let i = 2; used.has(name); i++) name = `${b}${String(i)}`;
    used.add(name);
    return name;
  };
  const tables = new Map<string, string>();
  for (const r of ir.resources) {
    const p = r.properties as { database?: string; name?: string };
    if (p.database !== undefined && p.name !== undefined && r.type !== "ClickHouse::Function") tables.set(`${p.database}.${p.name}`, r.logicalId);
  }
  const statements: Statement[] = [];
  const principals = new Map<string, string>();
  for (const name of [...roles].sort()) {
    const exportName = exportFor(name);
    principals.set(name, exportName);
    statements.push({ kind: "role", exportName, own: name, sql: await first(`SHOW CREATE ROLE ${ident(name)}`) });
  }
  for (const name of [...users].sort()) {
    const exportName = exportFor(name);
    principals.set(name, exportName);
    statements.push({ kind: "user", exportName, own: name, sql: withoutAuthentication(await first(`SHOW CREATE USER ${ident(name)}`)) });
  }
  for (const p of policies) {
    const sql = await first(`SHOW CREATE ROW POLICY ${ident(p.name)} ON ${ident(p.database)}.${ident(p.table)}`);
    statements.push({ kind: "policy", exportName: exportFor(`${p.table}_${p.name}`), own: p.name, sql });
  }
  // Quotas and settings profiles name the users and roles they apply to after TO, so they come after them.
  for (const { name } of await q<{ name: string }>("SELECT name FROM system.quotas WHERE storage <> 'users_xml' ORDER BY name")) {
    statements.push({ kind: "quota", exportName: exportFor(name), own: name, sql: await first(`SHOW CREATE QUOTA ${ident(name)}`) });
  }
  for (const { name } of await q<{ name: string }>("SELECT name FROM system.settings_profiles WHERE storage <> 'users_xml' ORDER BY name")) {
    statements.push({ kind: "settingsProfile", exportName: exportFor(name), own: name, sql: await first(`SHOW CREATE SETTINGS PROFILE ${ident(name)}`) });
  }
  for (const [grantee, lines] of grants) {
    lines.forEach((sql, i) => {
      statements.push({ kind: "grant", exportName: exportFor(`${grantee}_grant${lines.length > 1 ? `_${String(i + 1)}` : ""}`), sql });
    });
  }
  if (statements.length === 0) return { objects: [], warnings };

  const profiles = new Map(statements.flatMap((s) => (s.kind === "settingsProfile" && s.own !== undefined ? [[s.own, s.exportName] as const] : [])));
  const bodies = ordered(
    statements.map((s) => ({ s, ...templateOf(s, tables, principals, profiles) })),
    (b, cut) => ({ s: b.s, ...templateOf(b.s, tables, new Map([...principals].filter(([, exp]) => exp !== cut)), profiles) }),
    warnings,
  );
  const declared = new Set(statements.map((s) => s.exportName));
  const fromSchema = [...new Set(bodies.flatMap((b) => [...b.refs].filter((r) => !declared.has(r))))].sort();
  const tags = [...new Set(statements.map((s) => s.kind))].sort();
  const lines = [`import { ${tags.join(", ")} } from "@intentius/chant-lexicon-sql/clickhouse";`];
  if (fromSchema.length > 0) lines.push(`import { ${fromSchema.join(", ")} } from "./schema.js";`);
  lines.push("");
  for (const b of bodies) lines.push(`export const ${b.s.exportName} = ${b.s.kind}\`${b.body}\`;`, "");
  return {
    file: { path: "access.ts", content: `${lines.join("\n").trimEnd()}\n` },
    objects: statements.map((s) => (s.kind === "grant" ? `Grant ${s.sql}` : `${KIND_LABEL[s.kind]} ${s.own ?? ""}`)),
    warnings,
  };
}
