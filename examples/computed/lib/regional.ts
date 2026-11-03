// examples/computed/lib/regional.ts
import { Composite } from "@intentius/chant/composite";
import { index, table, type PostgresIndex, type PostgresTable } from "@intentius/chant-lexicon-sql/postgres";

// One partition, and one index on it, per region in the list.
export const RegionalPartitions = Composite((props: { parent: PostgresTable; regions: string[] }) => {
  const members: Record<string, PostgresTable | PostgresIndex> = {};
  for (const r of props.regions) {
    members[`part_${r}`] = table`CREATE TABLE shop.${`orders_${r}`} PARTITION OF ${props.parent} FOR VALUES IN (${`'${r}'`})`;
    members[`idx_${r}`] = index`CREATE INDEX ${`orders_${r}_at_idx`} ON shop.${`orders_${r}`} (at)`;
  }
  return members;
}, "RegionalPartitions");
