import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const yodel = database`
  CREATE DATABASE yodel_e2e_fixture
  ENGINE = Atomic
  COMMENT 'yodel e2e fixture'`;

export const events = table`
  CREATE TABLE ${yodel}.events (
    id   UInt64,
    kind LowCardinality(String),
    ts   DateTime
  )
  ENGINE = MergeTree
  ORDER BY (kind, ts)
  TTL ts + INTERVAL 90 DAY`;
