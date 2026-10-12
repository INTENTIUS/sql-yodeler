import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

export const shopDb = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example'`;

export const events = table<"shop.events">`
  CREATE TABLE ${shopDb}.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime,
      country LowCardinality(String) DEFAULT '',
      source LowCardinality(String) DEFAULT 'web'
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, id)`;
