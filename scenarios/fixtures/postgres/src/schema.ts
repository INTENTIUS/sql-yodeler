import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const db = schema`
  CREATE SCHEMA yodel_34_claim;
  COMMENT ON SCHEMA yodel_34_claim IS 'yodel claims fixture'`;

export const orders = table`
  CREATE TABLE ${db}.orders (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status text NOT NULL DEFAULT 'placed',
    amount numeric(12, 2) NOT NULL
  )`;

export const ordersStatus = index`
  CREATE INDEX orders_status_idx ON ${orders} (${orders.columns.status})`;
