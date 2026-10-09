/**
 * A migration's statements as one environment runs them. The source is
 * topology-neutral: `yodel new` writes each statement for a single node,
 * and at apply time each is rendered for the environment's topology with
 * chant's renderer (`ON CLUSTER` added or removed, the replicated engine
 * written). Pure.
 *
 * The history records a statement by the neutral statement's sha, so a
 * migration resumes the same way on every topology; the topology it was
 * sent for goes in the row's note ({@link topologyNote}).
 */

import { renderStatement, topologyLabel, type Topology } from "@intentius/chant-lexicon-sql/clickhouse/topology";

export type { Topology };

/** One neutral statement, as `topology` runs it. */
export const renderForEnvironment = (sql: string, topology: Topology): string => renderStatement(sql, topology);

/** The `note` a statement row carries: the topology the statement was rendered for. */
export const topologyNote = (topology: Topology): string => `topology=${topologyLabel(topology)}`;
