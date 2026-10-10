/**
 * A second server for a claim's second environment, holding the claim's
 * database (ClickHouse) or schema (Postgres) under the same name, as
 * staging and prod do: on Postgres a database of its own on the emulator,
 * `<claim db>_<suffix>`; on ClickHouse a scratch server in Docker (the
 * emulator's image), since a ClickHouse database name is the server's.
 * `close` drops the database or removes the container.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { clickhouseImage } from "@intentius/chant-lexicon-sql/spec/pin";
import type { Ctx } from "./claim.js";
import { clickhouseAt, endpoints, postgresQuery } from "./db.js";

export interface SecondServer {
  /** The profile's url. */
  url: string;
  /** Runs SQL there as the admin. */
  exec(sql: string): Promise<void>;
  /** The first column of the first row, as text ("" when there is none). */
  scalar(sql: string): Promise<string>;
  close(): Promise<void>;
}

export async function secondServer(ctx: Ctx, suffix: string): Promise<SecondServer> {
  if (ctx.dialect === "pg") {
    const name = `${ctx.db.name}_${suffix}`;
    const drop = () => postgresQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await drop();
    await postgresQuery(`CREATE DATABASE ${name}`);
    const url = new URL(endpoints.postgres);
    url.pathname = `/${name}`;
    const query = async (sql: string): Promise<Array<Record<string, unknown>>> => {
      const client = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), database: name, user: endpoints.postgresUser, password: endpoints.postgresPassword });
      await client.connect();
      try {
        const result = (await client.query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
        const last = Array.isArray(result) ? result.at(-1) : result;
        return (last?.rows ?? []) as Array<Record<string, unknown>>;
      } finally {
        await client.end();
      }
    };
    return {
      url: url.toString(),
      exec: async (sql) => { await query(sql); },
      scalar: async (sql) => {
        const v = Object.values((await query(sql))[0] ?? {})[0];
        if (v === null || v === undefined) return "";
        return typeof v === "string" || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
      },
      close: async () => { await drop(); },
    };
  }
  const name = `yodel-34-${ctx.claim}-${suffix}-${randomBytes(3).toString("hex")}`;
  const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });
  const started = docker(["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::8123", "--env", "CLICKHOUSE_SKIP_USER_SETUP=1", clickhouseImage()]);
  if (started.status !== 0) throw new Error(`could not start a second ClickHouse server: ${started.stderr}`);
  const close = () => {
    docker(["rm", "--force", "--volumes", name]);
    return Promise.resolve();
  };
  try {
    const port = /:(\d+)\s*$/m.exec(docker(["port", name, "8123/tcp"]).stdout)?.[1];
    if (!port) throw new Error(`docker did not publish ${name}'s port 8123`);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      try {
        await clickhouseAt(url, "SELECT 1");
        break;
      } catch (e) {
        if (i > 60) throw e;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    ctx.log(`second ClickHouse server: ${name} on ${url}`);
    return {
      url,
      exec: async (sql) => { await clickhouseAt(url, sql); },
      scalar: async (sql) => (await clickhouseAt(url, sql)).split("\n")[0]?.split("\t")[0]?.trim() ?? "",
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
