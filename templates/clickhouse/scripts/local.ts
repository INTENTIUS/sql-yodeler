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
 * it never refuses. Then, when there is no .env, it prints the credentials
 * that put dev on the emulator, for .env (the justfile reads it).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadChantConfig } from "@intentius/chant/config";
import { CLICKHOUSE_EMULATOR_SPEC, POSTGRES_EMULATOR, POSTGRES_EMULATOR_SPEC } from "@intentius/chant-lexicon-sql/op/activities";
import { connectPostgres } from "@intentius/chant-lexicon-sql/postgres/live/client";
import { environments, type Dialect } from "./ci.js";

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]"]);
const PG_PASSWORD = POSTGRES_EMULATOR.env("").POSTGRES_PASSWORD ?? "";

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

/** The .env lines that put dev on the emulator. */
function envLines(dialect: Dialect): string[] {
  const p = `DEV_${dialect.toUpperCase()}`;
  const [user, password] = dialect === "clickhouse" ? ["default", ""] : ["postgres", PG_PASSWORD];
  return ["READER", "WRITER"].flatMap((role) => [`${p}_${role}_USER=${user}`, `${p}_${role}_PASSWORD=${password}`]);
}

async function main(): Promise<number> {
  const dir = resolve(".");
  const { dialect } = await environments(dir);
  const { config } = await loadChantConfig(dir);
  const dev = (config as { sql?: { profiles?: Record<string, { url?: string }> } }).sql?.profiles?.dev?.url;
  const url = dev ? new URL(dev) : undefined;
  if (url && LOCAL.has(url.hostname)) {
    let why: string | undefined;
    try {
      why = await notTheEmulator(dialect, url);
    } catch (e) {
      why = `could not compare it with the emulator: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (why) {
      const v = `DEV_${dialect.toUpperCase()}_URL`;
      const lan = dialect === "clickhouse" ? "http://<this machine's LAN address>:8123" : "postgres://<this machine's LAN address>:5432/postgres";
      console.error(`warning: dev's server, ${url.host}, is not the emulator: ${why}.`);
      console.error(`  Another server on this machine holds that address, and dev's commands would reach it. Point dev at the emulator another way: ${v}=${lan} in .env (on macOS, ipconfig getifaddr en0 prints the address).`);
    } else {
      console.error(`dev's server, ${url.host}, is the emulator.`);
    }
  }
  if (!existsSync(join(dir, ".env"))) {
    console.error("For dev on the emulator, put these lines in .env (just reads it; .gitignore keeps it out of git):");
    for (const line of envLines(dialect)) console.error(`  ${line}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
