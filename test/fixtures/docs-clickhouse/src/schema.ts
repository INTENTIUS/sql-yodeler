import { database, table, view } from "@intentius/chant-lexicon-sql/clickhouse";

export const shop = database`
  CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'Orders and events'`;

export const events = table`
  CREATE TABLE ${shop}.events
  (
      id UInt64 COMMENT 'The event id',
      kind LowCardinality(String),
      at DateTime,
      amount Decimal(12, 2) DEFAULT 0
  )
  ENGINE = ReplacingMergeTree(at)
  PARTITION BY toYYYYMM(at)
  PRIMARY KEY (kind)
  ORDER BY (kind, id)
  TTL at + INTERVAL 1 YEAR
  COMMENT 'Every event, newest version per id'`;

export const dailyTotals = table`
  CREATE TABLE ${shop}.daily_totals
  (
      day Date,
      kind LowCardinality(String),
      total Decimal(18, 2)
  )
  ENGINE = SummingMergeTree
  ORDER BY (day, kind)`;

export const dailyTotalsMv = view`
  CREATE MATERIALIZED VIEW ${shop}.daily_totals_mv TO ${dailyTotals} AS
  SELECT toDate(at) AS day, kind, sum(amount) AS total
  FROM ${events}
  GROUP BY day, kind`;

export const recent = view`
  CREATE VIEW ${shop}.recent AS
  SELECT id, kind, at FROM ${events} WHERE at > now() - INTERVAL 1 DAY`;
