import { clickhouse, clickhouseReachable } from "./emulator.js";
import { suiteName } from "./names.js";
import { declarativeSuite } from "./declarative.js";

const SCHEMA = suiteName("declarative_ch");

declarativeSuite({
  name: SCHEMA,
  dialect: "clickhouse",
  reachable: clickhouseReachable,
  reset: async () => {
    await clickhouse(`DROP DATABASE IF EXISTS ${SCHEMA}`);
  },
  tableExists: async () => (await clickhouse(`EXISTS TABLE ${SCHEMA}.events`)).trim() === "1",
  declared: 2,
  addColumn: ["    ts   DateTime\n", "    ts   DateTime,\n    note String DEFAULT ''\n"],
  changeColumn: ["note String DEFAULT ''", "note String DEFAULT 'none'"],
  needsOp: ["ORDER BY (kind, ts)", "ORDER BY (ts, kind)"],
  foreign: async () => {
    await clickhouse(`CREATE TABLE ${SCHEMA}.handmade (x UInt8) ENGINE = MergeTree ORDER BY x`);
  },
  changeOutOfBand: async () => {
    await clickhouse(`ALTER TABLE ${SCHEMA}.events MODIFY TTL ts + INTERVAL 30 DAY`);
    return { name: "events", path: /^ttl$/ };
  },
  dropOutOfBand: async () => {
    await clickhouse(`DROP TABLE ${SCHEMA}.events`);
    return "events";
  },
});
