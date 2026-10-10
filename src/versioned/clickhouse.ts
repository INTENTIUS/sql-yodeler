/**
 * The versioned apply's ClickHouse driver: the Keeper (or local) lock
 * (`../history/lock.ts`), the catalog fingerprint over `system.tables`
 * (`./digest.ts`), and each statement rendered for the environment's
 * topology (#9) and sent, then its `succeeded` row appended. ClickHouse DDL
 * is not transactional, so the row follows the statement; a runner killed
 * between the two leaves the statement's latest row `started`, and the next
 * run sends it again.
 */

import type { ClickHouseEndpoint } from "@intentius/chant-lexicon-sql/clickhouse/http";
import { acquireLock, SINGLE, serverMessage, type ClickHousePort, type HistoryLocation } from "../history/index.js";
import { renderForEnvironment, topologyNote, type Topology } from "../topology/render.js";
import { catalogFingerprint, readLiveCatalog, type LiveScope } from "./digest.js";
import type { VersionedDriver } from "./driver.js";

export interface ClickHouseDriverInput {
  port: ClickHousePort;
  location: HistoryLocation;
  scope: LiveScope;
  serverKey: string;
  lockTtlMs: number;
  endpoint?: ClickHouseEndpoint | undefined;
  topology?: Topology | undefined;
}

export function clickhouseDriver(input: ClickHouseDriverInput): VersionedDriver {
  const { port } = input;
  const topology = input.topology ?? SINGLE;
  return {
    dialect: "clickhouse",
    rowNote: topologyNote(topology),
    acquireLock: (holder) =>
      acquireLock(port, { database: input.location.database, topology: input.location.topology, holder, ttlMs: input.lockTtlMs, serverKey: input.serverKey }),
    liveFingerprint: async () => catalogFingerprint(await readLiveCatalog(port, input.scope)),
    async readCheck(sql, where) {
      try {
        return await port.query(sql.trim().replace(/;+$/, ""), { settings: { readonly: "2", ...(where.defaultDatabase ? { database: where.defaultDatabase } : {}) } });
      } catch (e) {
        throw new Error(serverMessage(e), { cause: e });
      }
    },
    async runStatement(step, run) {
      try {
        await port.query(renderForEnvironment(step.sql, topology), step.waitsForMutation ? { settings: { mutations_sync: "2" } } : {});
      } catch (e) {
        throw new Error(serverMessage(e), { cause: e });
      }
      await run.succeeded("");
    },
    stepContext: () => ({ port, endpoint: input.endpoint }),
    close: () => Promise.resolve(),
  };
}
