/**
 * The replay empties every database (ClickHouse) or schema (Postgres) the
 * history names on the server its profile binds. When another profile binds
 * the same server and names one of those too (locally, `dev` and `replay`
 * both on the emulator at 127.0.0.1), the replay would drop that profile's
 * database: the one just applied to. So it refuses, naming the profile,
 * even with `--reset`, unless that profile is named with
 * `--reset-shared <profile>` (#12).
 *
 * Only profiles that resolve are compared: one whose credentials are not set
 * in this shell (a CI job that holds only the replay server's) binds no
 * server here, and the replay cannot reach its data through it.
 */

import { YodelError, type Environment, type Project } from "../project.js";
import { environmentSettings } from "../config/settings.js";
import { NOT_FRESH } from "./replay.js";

/** Another profile the replay would empty part of. */
export interface SharedProfile {
  profile: string;
  /** `host:port` (ClickHouse) or `host:port/database` (Postgres). */
  server: string;
  /** The databases or schemas both name. */
  names: string[];
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** A server URL as a comparable key: loopback names folded together, the default port filled in, no credentials. */
export function serverKey(dialect: Project["dialect"], url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = LOOPBACK.has(u.hostname) ? "127.0.0.1" : u.hostname.toLowerCase();
  if (dialect === "postgres") return `${host}:${u.port || "5432"}/${decodeURIComponent(u.pathname.replace(/^\/+/, "")) || "postgres"}`;
  return `${host}:${u.port || (u.protocol === "https:" ? "8443" : "8123")}`;
}

interface Bound {
  key: string;
  /** The databases or schemas the profile names; undefined is every one. */
  names: string[] | undefined;
}

async function bind(project: Project, name: string, processEnv: NodeJS.ProcessEnv): Promise<Bound | undefined> {
  if (project.dialect === "postgres") {
    const { resolvePostgresTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/postgres/live/bind");
    const t = resolvePostgresTarget({ environment: name, config: project.config, env: processEnv });
    if (isUnresolvedTarget(t) || !t.source.startsWith("sql.profiles.")) return undefined;
    return { key: serverKey("postgres", t.endpoint.url), names: t.schemas };
  }
  const { resolveClickHouseTarget, isUnresolvedTarget } = await import("@intentius/chant-lexicon-sql/clickhouse/live/bind");
  const t = resolveClickHouseTarget({ environment: name, config: project.config, env: processEnv });
  if (isUnresolvedTarget(t) || !t.source.startsWith("sql.profiles.")) return undefined;
  return { key: serverKey("clickhouse", t.endpoint.url), names: t.databases };
}

/** The other profiles on `env`'s server that name one of `scope`, the databases or schemas the replay empties. */
export async function sharedProfiles(project: Project, env: Environment, scope: readonly string[], processEnv: NodeJS.ProcessEnv = process.env): Promise<SharedProfile[]> {
  const profiles = Object.keys((project.config as { sql?: { profiles?: Record<string, unknown> } }).sql?.profiles ?? {});
  const own = await bind(project, env.name, processEnv);
  if (!own) return [];
  const shared: SharedProfile[] = [];
  for (const other of profiles) {
    if (other === env.name) continue;
    const b = await bind(project, other, processEnv).catch(() => undefined);
    if (!b || b.key !== own.key) continue;
    const history = environmentSettings(project, other, processEnv).historyDatabase;
    const theirs = b.names === undefined ? undefined : new Set([...b.names, history]);
    const names = scope.filter((s) => theirs === undefined || theirs.has(s));
    if (names.length > 0) shared.push({ profile: other, server: own.key, names });
  }
  return shared;
}

/** Refuses a replay that would empty another profile's databases, unless each such profile is named in `allowed`. */
export function refuseShared(env: Environment, shared: readonly SharedProfile[], allowed: readonly string[], dialect: Project["dialect"]): void {
  const blocking = shared.filter((s) => !allowed.includes(s.profile));
  if (blocking.length === 0) return;
  const what = dialect === "postgres" ? "schema" : "database";
  const lines = blocking.map(
    (s) => `${env.name} and ${s.profile} are the same server (${s.server}) and both name ${s.names.join(", ")}; the replay would drop ${s.profile}'s ${what}${s.names.length === 1 ? "" : "s"}, with or without --reset`,
  );
  throw new YodelError(
    `refused: ${lines.join("; ")}. Point ${env.name} at a throwaway server of its own (a second emulator on another port), ` +
      `or, to empty ${blocking.map((s) => s.profile).join(" and ")} too, add ${blocking.map((s) => `--reset-shared ${s.profile}`).join(" ")}. Nothing was run.`,
    NOT_FRESH,
  );
}
