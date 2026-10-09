import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const db = database`
  CREATE DATABASE yodel_34_claim
  ENGINE = Atomic
  COMMENT 'yodel claims fixture'`;

export const events = table`
  CREATE TABLE ${db}.events (
    id   UInt64,
    kind LowCardinality(String),
    ts   DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (kind, ts)
  TTL ts + INTERVAL 90 DAY`;

export const daily = table`
  CREATE TABLE ${db}.daily (
    day Date,
    n   UInt64
  )
  ENGINE = SummingMergeTree
  ORDER BY day`;
