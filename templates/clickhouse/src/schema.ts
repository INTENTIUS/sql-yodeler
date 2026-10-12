import { database, table } from "@intentius/chant-lexicon-sql/clickhouse";

// The declared schema: what the database should be. `npx yodel new <name>`
// writes the next migration from the change since the last one.
export const db = database`
  CREATE DATABASE {{chant:database}}
  ENGINE = Atomic
  COMMENT 'Declared in src/schema.ts'`;

export const events = table<"{{chant:database}}.events">`
  CREATE TABLE ${db}.events (
    id       UInt64,
    kind     LowCardinality(String),
    at       DateTime
  )
  ENGINE = MergeTree
  ORDER BY (kind, at)
  COMMENT 'One row per event'`;
