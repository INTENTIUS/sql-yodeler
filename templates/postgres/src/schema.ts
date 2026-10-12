import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

// The declared schema: what the database should be. `npx yodel new <name>`
// writes the next migration from the change since the last one.
export const app = schema`
  CREATE SCHEMA {{chant:schema}};
  COMMENT ON SCHEMA {{chant:schema}} IS 'Declared in src/schema.ts'`;

export const events = table<"{{chant:schema}}.events">`
  CREATE TABLE ${app}.events (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL,
    at   timestamptz NOT NULL DEFAULT now()
  )`;

export const eventsKind = index`
  CREATE INDEX events_kind_idx ON ${events} (${events.columns.kind})`;
