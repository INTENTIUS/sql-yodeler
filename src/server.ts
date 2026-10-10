/**
 * Which server a command reached, for the first line of its output (#11):
 * `postgres 16.14 at 127.0.0.1:5432/postgres`. A wrong target (a native
 * Postgres on localhost:5432 instead of the emulator) then shows in the
 * header, by its address and its version.
 *
 * The address comes from the profile's URL, without credentials; the
 * version is asked of the server. A server that does not answer the version
 * query still gets its address.
 */

import type { Environment, Project, SqlDialect } from "./project.js";

export interface ServerInfo {
  dialect: SqlDialect;
  /** `host:port/database` on Postgres, `host:port` on ClickHouse. */
  address: string;
  /** The server's own version string, first word: `16.14`, `25.3.2.39`. */
  version?: string | undefined;
}

/** `postgres 16.14 at 127.0.0.1:5432/postgres`. */
export function describeServer(s: ServerInfo): string {
  return `${s.dialect}${s.version ? ` ${s.version}` : ""} at ${s.address}`;
}

/** `host:port/database` (Postgres) or `host:port` (ClickHouse) from a server URL, with no credentials. */
export function serverAddress(dialect: SqlDialect, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//");
  }
  if (dialect === "postgres") {
    const port = u.port || "5432";
    const db = decodeURIComponent(u.pathname.replace(/^\/+/, "")) || "postgres";
    return `${u.hostname}:${port}/${db}`;
  }
  const port = u.port || (u.protocol === "https:" ? "8443" : "8123");
  return `${u.hostname}:${port}`;
}

/** The first word of a version string: `16.14 (Homebrew)` is `16.14`. */
export const versionWord = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim().split(/\s+/)[0] : undefined);

/** Asks a Postgres connection its version. */
export async function postgresVersion(client: { query<T>(sql: string): Promise<T[]> }): Promise<string | undefined> {
  const rows = await client.query<{ server_version?: string }>("SHOW server_version");
  return versionWord(rows[0]?.server_version);
}

/** Asks a ClickHouse server its version. */
export async function clickhouseVersion(port: { query<T>(sql: string): Promise<T[]> }): Promise<string | undefined> {
  const rows = await port.query<{ version?: string }>("SELECT version() AS version");
  return versionWord(rows[0]?.version);
}

/** Runs `probe`, giving up quietly: the header is worth a line, not a failure. */
export async function softly<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe();
  } catch {
    return undefined;
  }
}

/**
 * The server `sql.profiles.<env>` binds, with its version when it answers,
 * for a command that does not hold its own connection (the declarative plan
 * and apply, drift). Undefined when the profile binds no server.
 */
export async function probeServer(project: Project, env: Environment, processEnv: NodeJS.ProcessEnv = process.env): Promise<ServerInfo | undefined> {
  return softly(async () => {
    if (project.dialect === "postgres") {
      const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
      const target = resolvePostgresTarget({ environment: env.name, config: project.config, env: processEnv });
      if (isUnresolvedTarget(target)) return undefined;
      const info: ServerInfo = { dialect: "postgres", address: serverAddress("postgres", target.endpoint.url) };
      const { connectPostgres } = await import("@intentius/chant-lexicon-sql/postgres/live/client");
      const client = await softly(() => connectPostgres(target.endpoint, { applicationName: "yodel" }));
      if (client) {
        try {
          info.version = await softly(() => postgresVersion(client));
        } finally {
          await client.end();
        }
      }
      return info;
    }
    const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
    const target = resolveClickHouseTarget({ environment: env.name, config: project.config, env: processEnv });
    if (isUnresolvedTarget(target)) return undefined;
    const { httpPort } = await import("./history/client.js");
    const port = await httpPort(target.endpoint);
    return { dialect: "clickhouse", address: serverAddress("clickhouse", target.endpoint.url), version: await softly(() => clickhouseVersion(port)) };
  });
}
