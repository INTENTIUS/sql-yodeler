import { describe, expect, it } from "vitest";
import { stampedComment } from "@intentius/chant-lexicon-sql/core/ownership";
import { cleanupDigest, cleanupGate, describeRetained, dropRetained, dropStatements, findRetained, type Retained } from "../src/cleanup/index.js";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const old = (of: string, until: string | undefined, key = "rebuild") => stampedComment(`the old table, kept until ${until ?? "?"}`, undefined, { [key]: of, role: "old", ...(until ? { "retain-until": until } : {}) });

/** A ClickHouse server with these tables, recording what it is sent. */
function clickhouse(tables: Array<{ database: string; name: string; uuid: string; comment: string }>) {
  const sent: string[] = [];
  return {
    sent,
    query: <Row>(sql: string) => {
      if (sql.startsWith("SELECT toUnixTimestamp64Milli")) return Promise.resolve([{ now: String(NOW) }] as Row[]);
      if (sql.startsWith("SELECT database, name, toString(uuid)")) return Promise.resolve(tables as Row[]);
      sent.push(sql);
      return Promise.resolve([] as Row[]);
    },
  };
}

describe("yodel cleanup's gate (#119)", () => {
  it("is the migrations Op's gate name with -cleanup, apart from the apply's", () => {
    expect(cleanupGate("approve-migrate-prod")).toBe("approve-migrate-prod-cleanup");
  });
});

describe("yodel cleanup's list", () => {
  it("finds a rebuild's old tables, due once their date has passed by the server's clock, and only those", async () => {
    const port = clickhouse([
      { database: "shop", name: "events__chant_old", uuid: "u-1", comment: old("shop.events", "2026-10-17T05:30:05.216Z") },
      { database: "shop", name: "daily__chant_old", uuid: "u-2", comment: old("shop.daily", "2026-10-27T00:00:00.000Z") },
      { database: "shop", name: "mine__chant_old", uuid: "u-3", comment: "a table someone named like that" },
      { database: "shop", name: "nodate__chant_old", uuid: "u-4", comment: old("shop.nodate", undefined) },
    ]);
    const { now, retained } = await findRetained({ dialect: "clickhouse", port, databases: ["shop"] });
    expect(now).toBe("2026-10-20T00:00:00.000Z");
    expect(retained.map((r) => [r.name, r.due])).toEqual([
      ["shop.events__chant_old", true],
      ["shop.daily__chant_old", false],
      ["shop.nodate__chant_old", false],
    ]);
    const [events, , nodate] = retained as [Retained, Retained, Retained];
    expect(describeRetained(events)).toBe("shop.events__chant_old (the old table of the rebuild of shop.events): kept until 2026-10-17T05:30:05.216Z, due");
    expect(describeRetained(nodate)).toContain("no retention date in its comment, never dropped");

    // The digest covers what is due, by identity and date: another table due, or the same name with another UUID, is another digest.
    const digest = await cleanupDigest("prod", retained);
    expect(digest).toMatch(/^jcs1-sha256:/);
    expect(await cleanupDigest("prod", retained)).toBe(digest);
    expect(await cleanupDigest("prod", retained.map((r) => (r.due ? { ...r, identity: "u-9" } : r)))).not.toBe(digest);
    expect(await cleanupDigest("prod", retained.map((r) => ({ ...r, due: true })))).not.toBe(digest);
    expect(await cleanupDigest("staging", retained)).not.toBe(digest);

    // Only the due one is dropped.
    expect(await dropRetained({ dialect: "clickhouse", port, databases: ["shop"] }, retained, () => undefined)).toEqual(["shop.events__chant_old"]);
    expect(port.sent).toEqual(["DROP TABLE `shop`.`events__chant_old` SYNC"]);
  });

  it("renders a ClickHouse drop for the environment's topology", () => {
    const r = { kind: "table" as const, name: "shop.events__chant_old", of: "shop.events", due: true, identity: "u" };
    expect(dropStatements(r, { kind: "cluster", cluster: "main" } as never)[0]).toContain("ON CLUSTER");
  });

  it("finds a Postgres column migration's old column, with the trigger and function a rename keeps, and drops them in one transaction", async () => {
    const sent: string[] = [];
    const colComment = stampedComment("the old name, kept until 2026-10-19T00:00:00.000Z", undefined, { migration: "shop.orders.email", role: "old", "retain-until": "2026-10-19T00:00:00.000Z" });
    const dual = stampedComment("keeps the new column written", undefined, { migration: "shop.orders.email", role: "dual" });
    const client = {
      query: <T>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        const rows = (r: unknown[]) => Promise.resolve(r as T[]);
        if (sql.includes("clock_timestamp")) return rows([{ now: String(NOW) }]);
        if (sql.includes("FROM pg_catalog.pg_attribute a")) {
          expect(params).toEqual([["shop"]]);
          return rows([{ schema: "shop", table: "orders", oid: "16384", column: "customer_email", attnum: "3", comment: colComment }]);
        }
        if (sql.includes("pg_trigger")) return rows([{ comment: dual }]);
        if (sql.includes("pg_proc")) return rows([{ comment: dual }]);
        if (sql.includes("to_regclass")) return rows([{ present: false, comment: null }]);
        sent.push(sql);
        return rows([]);
      },
    };
    const server = { dialect: "postgres" as const, client, schemas: ["shop"], lockTimeoutMs: 5000 };
    const { retained } = await findRetained(server);
    expect(retained).toEqual([
      { kind: "column", name: "shop.orders.customer_email", of: "shop.orders.email", retainUntil: "2026-10-19T00:00:00.000Z", due: true, identity: "16384:3", trigger: { name: "email__chant_sync", fn: "orders__email__chant_sync" }, marker: {} },
    ]);
    expect(await dropRetained(server, retained, () => undefined)).toEqual(["shop.orders.customer_email"]);
    expect(sent).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '5000ms'",
      'DROP TRIGGER "email__chant_sync" ON "shop"."orders"',
      'DROP FUNCTION "shop"."orders__email__chant_sync"()',
      'ALTER TABLE "shop"."orders" DROP COLUMN "customer_email"',
      "COMMIT",
    ]);
  });
});
