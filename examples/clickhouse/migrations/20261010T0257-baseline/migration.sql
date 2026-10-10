-- yodel migration 20261010T0257-baseline
-- parent: none (the first migration)

-- yodel18ShopDb (yodel_18_shop): SQLCH200 create
CREATE DATABASE yodel_18_shop
  ENGINE = Atomic
  COMMENT 'The SQL Yodeler ClickHouse example [chant managed-by=chant]';

-- events (yodel_18_shop.events): SQLCH200 create
CREATE TABLE yodel_18_shop.events
  (
      id UInt64,
      kind LowCardinality(String),
      at DateTime
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(at)
  ORDER BY (kind, at) COMMENT '[chant managed-by=chant]';
