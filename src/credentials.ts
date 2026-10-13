/**
 * The reader and the writer of an environment (#50), for a project's
 * `chant.config.ts`:
 *
 * ```ts
 * import { credentials } from "@intentius/sql-yodeler";
 *
 * profiles: {
 *   dev: { url: "postgres://127.0.0.1:5432/app", ...credentials("dev", "postgres"), schemas: ["app"] },
 *   prod: {
 *     url: "postgres://db.abc.us-east-1.rds.amazonaws.com:5432/app",
 *     ...credentials("prod", "postgres", { writer: { password: { token: "rds-iam" } } }),
 *     schemas: ["app"],
 *   },
 * }
 * ```
 *
 * `YODEL_ROLE` picks the role a process connects as: the reader unless it
 * is `writer` (every environment) or `writer:<env>` (that one). Its older
 * name, `YODEL_CREDENTIALS`, is still read (#268).
 * Only an environment's apply job sets it. Each role reads its user and its
 * password from a variable, by default `<ENV>_<DIALECT>_READER_USER`,
 * `..._READER_PASSWORD`, `..._WRITER_USER` and `..._WRITER_PASSWORD`
 * (`DEV_POSTGRES_READER_USER`), the names `yodel ci` maps the forge's
 * secrets to. A role's password can instead be a short-lived token, minted
 * by chant's sql lexicon when a connection needs it: `{ token: "rds-iam" }`,
 * `{ token: "cloud-sql-iam" }` or `{ token: "entra" }` (Postgres), or
 * `{ token: "command", command: ["./mint.sh"] }` (either dialect).
 *
 * The profile carries both roles under a symbol chant does not read, so
 * yodel sees the reader and the writer from one evaluation of the config:
 * it refuses (exit 4) an environment whose two roles are the same user or
 * read the same variable, and `yodel ci` gives each job the variables, and
 * the cloud identity, of the role it runs as.
 */

/** A value read from an environment variable, as chant's profiles name one. */
export interface EnvRef {
  env: string;
}

/** A short-lived password, minted by chant's sql lexicon when a connection needs one. */
export type TokenSource =
  | { token: "rds-iam"; region?: string; ttlSeconds?: number }
  | { token: "cloud-sql-iam"; ttlSeconds?: number }
  | { token: "entra"; ttlSeconds?: number }
  | { token: "command"; command: string[]; ttlSeconds?: number };

/** The token sources that mint from a cloud identity, which a CI job gets over OIDC. */
export type CloudToken = Exclude<TokenSource["token"], "command">;

export const CLOUD_TOKENS: readonly CloudToken[] = ["rds-iam", "cloud-sql-iam", "entra"];

export type Role = "reader" | "writer";

export const ROLES: readonly Role[] = ["reader", "writer"];

/** One role's user and password. Either left out is read from its default variable. */
export interface RoleCredentials {
  user?: EnvRef;
  password?: EnvRef | TokenSource;
}

export type CredentialsDialect = "clickhouse" | "postgres";

/** Both roles of one environment, as {@link credentials} recorded them. */
export interface Credentials {
  env: string;
  dialect: CredentialsDialect;
  /** The role this process connects as. */
  role: Role;
  reader: { user: EnvRef; password: EnvRef | TokenSource };
  writer: { user: EnvRef; password: EnvRef | TokenSource };
}

/** Where a profile made by {@link credentials} keeps both roles. A symbol, so chant's strict profile schema does not see it. */
export const CREDENTIALS: unique symbol = Symbol.for("@intentius/sql-yodeler/credentials") as never;

/** What {@link credentials} returns: the chosen role's `user` and `password`, to spread into the profile. */
export interface ProfileCredentials {
  user: EnvRef;
  password: EnvRef | TokenSource;
  [CREDENTIALS]: Credentials;
}

/** DEV_POSTGRES for dev on Postgres: what an environment's variables start with. */
export const credentialsPrefix = (env: string, dialect: CredentialsDialect): string => `${env.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${dialect.toUpperCase()}`;

/** The variable that picks the role a process connects as (#268), and its older name, still read. */
export const ROLE_VAR = "YODEL_ROLE";
export const OLD_ROLE_VAR = "YODEL_CREDENTIALS";

/**
 * The variable that picks the role in `processEnv` and its value:
 * `YODEL_ROLE`, else `YODEL_CREDENTIALS`. Undefined when neither is set;
 * throws when both are and they differ, so neither is silently ignored.
 */
export function roleSetting(processEnv: NodeJS.ProcessEnv = process.env): { name: string; value: string } | undefined {
  const value = processEnv[ROLE_VAR];
  const old = processEnv[OLD_ROLE_VAR];
  if (value && old && value !== old) throw new Error(`${ROLE_VAR} is ${value} and ${OLD_ROLE_VAR}, its older name, is ${old}: set one of them`);
  if (value) return { name: ROLE_VAR, value };
  return old ? { name: OLD_ROLE_VAR, value: old } : undefined;
}

/** The role `YODEL_ROLE` picks for `env`: the writer under `writer` or `writer:<env>`, else the reader. */
export function roleOf(env: string, value: string | undefined = roleSetting()?.value): Role {
  return value === "writer" || value === `writer:${env}` ? "writer" : "reader";
}

/**
 * The profile's `user` and `password` for the role `YODEL_ROLE`
 * picks, with both roles recorded for yodel. `roles` replaces a role's
 * user or password; what it leaves out is read from the default variable.
 */
export function credentials(env: string, dialect: CredentialsDialect, roles: { reader?: RoleCredentials; writer?: RoleCredentials } = {}): ProfileCredentials {
  const prefix = credentialsPrefix(env, dialect);
  const of = (role: Role) => {
    const r = roles[role] ?? {};
    const upper = role.toUpperCase();
    return { user: r.user ?? { env: `${prefix}_${upper}_USER` }, password: r.password ?? { env: `${prefix}_${upper}_PASSWORD` } };
  };
  const role = roleOf(env);
  const recorded: Credentials = { env, dialect, role, reader: of("reader"), writer: of("writer") };
  const chosen = recorded[role];
  return { user: chosen.user, password: chosen.password, [CREDENTIALS]: recorded };
}

/** The roles a profile made by {@link credentials} carries; undefined for any other profile. */
export function credentialsOf(profile: unknown): Credentials | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const c = (profile as Record<symbol, unknown>)[CREDENTIALS];
  return typeof c === "object" && c !== null ? (c as Credentials) : undefined;
}

const isEnvRef = (v: unknown): v is EnvRef => typeof v === "object" && v !== null && typeof (v as { env?: unknown }).env === "string";

/** The variables a role reads its user and password from (a token source reads none). */
export function roleVariables(c: Credentials, role: Role): string[] {
  const r = c[role];
  return [r.user, r.password].filter(isEnvRef).map((v) => v.env);
}

/** The cloud token source a role's password is minted by, if it is one. */
export function cloudToken(c: Credentials, role: Role): CloudToken | undefined {
  const p = c[role].password;
  return !isEnvRef(p) && (CLOUD_TOKENS as readonly string[]).includes(p.token) ? (p.token as CloudToken) : undefined;
}

/** How a role's password is got, for a message: `DEV_POSTGRES_READER_PASSWORD` or `a rds-iam token`. */
export function describePassword(p: EnvRef | TokenSource): string {
  if (isEnvRef(p)) return p.env;
  return p.token === "command" ? `a command token (${p.command[0] ?? ""})` : `a ${p.token} token`;
}

/**
 * Why environment `c.env`'s reader and writer are not two identities, or
 * undefined when they are: both name the same user variable, both users
 * resolve to the same name in `processEnv`, or both read the same password
 * variable (a job holding the reader's would hold the writer's). The
 * message names the variables and the user.
 */
export function sharedCredentials(c: Credentials, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const where = `sql.profiles.${c.env}`;
  const { reader, writer } = c;
  if (reader.user.env === writer.user.env) {
    return `${where}: the reader and the writer read their user from the same variable, ${reader.user.env}, so a job that holds the reader holds the writer. Give the writer a user of its own (${credentialsPrefix(c.env, c.dialect)}_WRITER_USER).`;
  }
  const r = processEnv[reader.user.env];
  const w = processEnv[writer.user.env];
  if (r !== undefined && r !== "" && r === w) {
    return `${where}: the reader (${reader.user.env}) and the writer (${writer.user.env}) are the same user, ${r}, so a job that holds the reader can write. Give each role its own database user.`;
  }
  if (isEnvRef(reader.password) && isEnvRef(writer.password) && reader.password.env === writer.password.env) {
    return `${where}: the reader and the writer read their password from the same variable, ${reader.password.env}, so a job that holds the reader holds the writer's password. Give the writer a password variable of its own.`;
  }
  return undefined;
}

/** The first refusal among a config's profiles, checked in order; see {@link sharedCredentials}. */
export function sharedCredentialsIn(profiles: Record<string, unknown>, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const profile of Object.values(profiles)) {
    const c = credentialsOf(profile);
    const why = c ? sharedCredentials(c, processEnv) : undefined;
    if (why) return why;
  }
  return undefined;
}

/**
 * What a printed command that writes starts with for `profile` (#159):
 * `YODEL_ROLE=writer:<env> ` when the profile has a reader and a
 * writer of its own, so the command a hint prints runs as the writer
 * whatever the shell it is pasted into holds; nothing for any other profile.
 */
export function writerPrefix(profile: unknown): string {
  const c = credentialsOf(profile);
  return c ? `${ROLE_VAR}=writer:${c.env} ` : "";
}

/** The user a profile's chosen role connects as, for a message: `DEV_CLICKHOUSE_READER_USER (reader)`, or the variable alone when it is not set here. */
function connectsAs(user: unknown, processEnv: NodeJS.ProcessEnv): string | undefined {
  if (!isEnvRef(user)) return typeof user === "string" && user !== "" ? user : undefined;
  const value = processEnv[user.env];
  return value !== undefined && value !== "" ? `${user.env} (${value})` : user.env;
}

/**
 * The refusal (#159) of `command`, which writes, when this process holds
 * `profile`'s reader: one line naming the reader's user and the variable
 * that picks the writer. Undefined when the profile has no separate reader
 * and writer, or this process holds the writer.
 */
export function readerRefusal(profile: unknown, command: string, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const c = credentialsOf(profile);
  if (!c || c.role !== "reader") return undefined;
  const set = roleSetting(processEnv);
  return (
    `refused: ${command} writes, and this process holds ${c.env}'s reader, ${connectsAs(c.reader.user, processEnv) ?? c.reader.user.env}, ` +
    `because ${set ? `${set.name} is ${set.value}, not writer or writer:${c.env}` : `${ROLE_VAR} is not set`}. ` +
    `Run it as the writer: ${ROLE_VAR}=writer:${c.env} ${command}. Nothing was done.`
  );
}

/** Postgres SQLSTATEs and ClickHouse error codes that mean the user lacks a privilege: insufficient_privilege, read_only_sql_transaction; READONLY, ACCESS_DENIED. */
const PG_DENIED = new Set(["42501", "25006"]);
const CH_DENIED = /\bCode: (164|497)\b|\b(ACCESS_DENIED|READONLY)\b|Not enough privileges/;

/** The server's own message of an error, its first line, without ClickHouse's trailing version. */
function serverLine(e: unknown): string {
  const text = (e as { serverMessage?: unknown } | null)?.serverMessage;
  const message = typeof text === "string" ? text : e instanceof Error ? e.message : String(e);
  return (message.trim().split("\n")[0] ?? "").replace(/ \(version .*\)\.?$/, "");
}

/** Whether `e` is the server refusing a statement for want of a privilege. */
export function isPermissionDenied(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" && PG_DENIED.has(code)) return true;
  const text = (e as { serverMessage?: unknown }).serverMessage;
  const message = typeof text === "string" ? text : e instanceof Error ? e.message : "";
  return CH_DENIED.test(message) || /^permission denied\b/i.test(message);
}

/**
 * One line (#159) for the server refusing `command` a privilege, in place
 * of the error and its stack: the user it connected as, the server's
 * message (which names the grant), and, when `profile` connected as its
 * reader, the variable that picks the writer. Undefined for any other error.
 */
export function permissionRefusal(e: unknown, profile: unknown, command: string, processEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isPermissionDenied(e)) return undefined;
  const c = credentialsOf(profile);
  const role = c ? `${c.env}'s ${c.role}, ` : "";
  const user = connectsAs((profile as { user?: unknown } | null)?.user, processEnv);
  const fix = c?.role === "reader"
    ? `Run it as the writer: ${ROLE_VAR}=writer:${c.env} ${command}.`
    : `Grant that user what the server names, or connect as a user that has it.`;
  return `refused: the server refused ${command}, which connected as ${role}${user ?? "the profile's user"}: ${serverLine(e)}. ${fix}`;
}
