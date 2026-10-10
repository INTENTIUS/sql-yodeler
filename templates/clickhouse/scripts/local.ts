/**
 * What `just up` runs after `chant emulator up`: is dev's server the
 * emulator?
 *
 *   npx tsx scripts/local.ts
 *
 * When the dev profile's URL is on this machine (127.0.0.1 or localhost),
 * asks that address which server it is and compares the answer with the
 * emulator's container. Another server installed on this machine (a
 * Postgres on 5432, say) can hold the address the emulator publishes on,
 * and then dev's commands reach it, not the emulator. It warns and exits 0:
 * it never refuses.
 *
 * yodel refuses an environment whose reader and writer are one user, so on
 * the emulator (at 127.0.0.1, or at another address of this machine given
 * in DEV_<DIALECT>_URL) it makes the read-only reader dev reads with, once:
 * ClickHouse user `reader` (`readonly = 1`, SELECT and SHOW), Postgres role
 * `reader` (password `reader`, `default_transaction_read_only = on`,
 * pg_read_all_data). The writer is the emulator's own admin user. Then,
 * when there is no .env, it prints the reader and writer lines that put dev
 * on the emulator, for .env (the justfile reads it); when .env names one
 * user as both, it says so.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadChantConfig } from "@intentius/chant/config";
import { CLICKHOUSE_EMULATOR_SPEC, POSTGRES_EMULATOR, POSTGRES_EMULATOR_SPEC } from "@intentius/chant-lexicon-sql/op/activities";
import { connectPostgres } from "@intentius/chant-lexicon-sql/postgres/live/client";

type Dialect = "clickhouse" | "postgres";

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** This machine's other addresses (its LAN address, say): dev on one of them may be the emulator too. */
const thisMachine = () => new Set(Object.values(networkInterfaces()).flatMap((xs) => (xs ?? []).map((x) => (x.family === "IPv6" ? `[${x.address}]` : x.address))));
const PG_PASSWORD = POSTGRES_EMULATOR.env("").POSTGRES_PASSWORD ?? "";

/** The emulator's users: the read-only reader this script makes, and the admin user, dev's writer. */
export const USERS = {
  clickhouse: { reader: { user: "reader", password: "" }, writer: { user: "default", password: "" } },
  postgres: { reader: { user: "reader", password: "reader" }, writer: { user: "postgres", password: PG_PASSWORD } },
} as const;

/** The statements that make the reader, run as the writer. Each can run again. */
export function readerStatements(dialect: Dialect): string[] {
  const { user, password } = USERS[dialect].reader;
  if (dialect === "clickhouse") {
    return [`CREATE USER IF NOT EXISTS ${user} IDENTIFIED WITH no_password SETTINGS readonly = 1`, `GRANT SELECT, SHOW ON *.* TO ${user}`];
  }
  return [
    `DO $$ BEGIN CREATE ROLE ${user} LOGIN PASSWORD '${password}'; EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
    `ALTER ROLE ${user} SET default_transaction_read_only = on`,
    `GRANT pg_read_all_data TO ${user}`,
  ];
}

/** Makes the read-only reader on the server at url, as the emulator's admin user. */
export async function makeReader(dialect: Dialect, url: URL): Promise<void> {
  if (dialect === "clickhouse") {
    for (const sql of readerStatements(dialect)) {
      const res = await fetch(url, { method: "POST", body: sql, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`${sql}: ${(await res.text()).trim()}`);
    }
    return;
  }
  const { user, password } = USERS.postgres.writer;
  const client = await connectPostgres({ url: url.toString(), user, password }, { applicationName: "just up" });
  try {
    for (const sql of readerStatements(dialect)) await client.query(sql);
  } finally {
    await client.end();
  }
}

const docker = (args: string[]): string => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Undefined when `url` reaches the emulator's container; otherwise what it reached instead. */
async function notTheEmulator(dialect: Dialect, url: URL): Promise<string | undefined> {
  if (dialect === "clickhouse") {
    const container = CLICKHOUSE_EMULATOR_SPEC.name;
    const want = docker(["inspect", "--format", "{{.Config.Hostname}}", container]);
    const got = (await (await fetch(new URL("/?query=SELECT%20hostName()", url), { signal: AbortSignal.timeout(10_000) })).text()).trim();
    return got === want ? undefined : `it answers as host ${got}, and ${container} is ${want}`;
  }
  const container = POSTGRES_EMULATOR_SPEC.name;
  const query = "SELECT system_identifier::text AS id FROM pg_control_system()";
  const want = docker(["exec", container, "psql", "-U", "postgres", "-tAc", query]);
  let client;
  try {
    client = await connectPostgres({ url: url.toString(), user: "postgres", password: PG_PASSWORD }, { applicationName: "just up" });
  } catch (e) {
    return `it refuses the emulator's login, postgres/${PG_PASSWORD} (${e instanceof Error ? e.message : String(e)})`;
  }
  try {
    const got = (await client.query<{ id: string }>(query))[0]?.id;
    return got === want ? undefined : `its system identifier is ${String(got)}, and ${container}'s is ${want}`;
  } finally {
    await client.end();
  }
}

/** The .env lines that put dev on the emulator: the reader, then the writer. */
export function envLines(dialect: Dialect): string[] {
  const p = `DEV_${dialect.toUpperCase()}`;
  return (["reader", "writer"] as const).flatMap((role) => {
    const { user, password } = USERS[dialect][role];
    return [`${p}_${role.toUpperCase()}_USER=${user}`, `${p}_${role.toUpperCase()}_PASSWORD=${password}`];
  });
}

async function main(): Promise<number> {
  const dir = resolve(".");
  const { config } = await loadChantConfig(dir);
  const dialect = (config as { sql?: { dialect?: string } }).sql?.dialect;
  if (dialect !== "clickhouse" && dialect !== "postgres") throw new Error(`chant.config.ts: sql.dialect must be clickhouse or postgres, got ${String(dialect)}`);
  const dev = (config as { sql?: { profiles?: Record<string, { url?: string }> } }).sql?.profiles?.dev?.url;
  const url = dev ? new URL(dev) : undefined;
  let emulator = false;
  if (url && (LOCAL.has(url.hostname) || thisMachine().has(url.hostname))) {
    let why: string | undefined;
    try {
      why = await notTheEmulator(dialect, url);
    } catch (e) {
      why = `could not compare it with the emulator: ${e instanceof Error ? e.message : String(e)}`;
    }
    emulator = why === undefined;
    // Another address of this machine may reach another server on purpose: nothing to warn about.
    if (!LOCAL.has(url.hostname)) {
      if (emulator) console.error(`dev's server, ${url.host}, is the emulator.`);
    } else if (why) {
      const v = `DEV_${dialect.toUpperCase()}_URL`;
      const lan = dialect === "clickhouse" ? "http://<this machine's LAN address>:8123" : "postgres://<this machine's LAN address>:5432/postgres";
      console.error(`warning: dev's server, ${url.host}, is not the emulator: ${why}.`);
      console.error(`  Another server on this machine holds that address, and dev's commands would reach it. Point dev at the emulator another way: ${v}=${lan} in .env (on macOS, ipconfig getifaddr en0 prints the address).`);
    } else {
      console.error(`dev's server, ${url.host}, is the emulator.`);
    }
  }
  if (url && emulator) {
    try {
      await makeReader(dialect, url);
      console.error(`The emulator has the read-only user ${USERS[dialect].reader.user}, dev's reader; ${USERS[dialect].writer.user} is dev's writer.`);
    } catch (e) {
      console.error(`warning: could not make the read-only user ${USERS[dialect].reader.user} on the emulator (${e instanceof Error ? e.message : String(e)}). Run these as ${USERS[dialect].writer.user}:`);
      for (const sql of readerStatements(dialect)) console.error(`  ${sql};`);
    }
  }
  const p = `DEV_${dialect.toUpperCase()}`;
  if (!existsSync(join(dir, ".env"))) {
    console.error("For dev on the emulator, put these lines in .env (just reads it; .gitignore keeps it out of git):");
    for (const line of envLines(dialect)) console.error(`  ${line}`);
  } else if (process.env[`${p}_READER_USER`] && process.env[`${p}_READER_USER`] === process.env[`${p}_WRITER_USER`]) {
    console.error(`warning: .env names ${String(process.env[`${p}_READER_USER`])} as dev's reader and writer, and yodel refuses one user as both. For dev on the emulator, use:`);
    for (const line of envLines(dialect)) console.error(`  ${line}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
