-- yodel migration 20261010T1722-baseline
-- parent: none (the first migration)

-- shopDb (shop): SQLCH200 create
CREATE DATABASE shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example [chant managed-by=chant]';

-- events (shop.events): SQLCH200 create
CREATE TABLE shop.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at) COMMENT '[chant managed-by=chant]';
