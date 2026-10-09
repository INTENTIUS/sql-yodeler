/**
 * Prints three statements like the ClickHouse example's migrations hold as `yodel
 * apply` sends them on each topology (the renderer it calls per statement,
 * src/topology/render.ts), and the history's database and table engine for
 * each (src/history/ddl.ts). Offline; docs/topology.md shows its output.
 *
 *   npx tsx examples/walkthrough/topology.ts
 */

import { toTopology } from "@intentius/chant-lexicon-sql/clickhouse/topology";
import { renderForEnvironment } from "../../src/topology/render.js";
import { databaseDdl, historyEngine } from "../../src/history/ddl.js";
import { historyTopologyOf } from "../../src/config/settings.js";

const statements = [
  "CREATE DATABASE yodel_18_shop ENGINE = Atomic",
  "CREATE TABLE yodel_18_shop.events (id UInt64, kind LowCardinality(String), at DateTime) ENGINE = MergeTree PARTITION BY toYYYYMM(at) ORDER BY (kind, at)",
  "ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`",
];

export function render(): string {
  const out: string[] = [];
  for (const setting of ["single", "cluster:main", "replicated", "replicated:main", "cloud"]) {
    const topology = toTopology(setting);
    const history = { database: "yodeler", topology: historyTopologyOf(topology) };
    out.push(`-- topology: ${setting}`);
    for (const sql of statements) out.push(`${renderForEnvironment(sql, topology)};`);
    out.push(`-- the history: ${databaseDdl(history)}`, `--   its table's engine: ${historyEngine(history)}`, "");
  }
  return out.join("\n");
}

if (process.argv[1]?.endsWith("topology.ts")) console.log(render());
