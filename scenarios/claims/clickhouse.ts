/**
 * What only ClickHouse has: rebuilding a table for a sort-key change, and
 * replicated and sharded topologies. scenarios/lib/claim.ts {@link rollup}
 * runs the members in turn.
 */

import { rollup } from "../lib/claim.js";
import { rebuild } from "./clickhouse/rebuild.js";
import { topology } from "./clickhouse/topology.js";

export const clickhouse = rollup("clickhouse", [rebuild, topology]);
