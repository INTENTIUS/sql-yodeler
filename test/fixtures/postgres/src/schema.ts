import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`
  CREATE SCHEMA yodel_6;
  COMMENT ON SCHEMA yodel_6 IS 'yodel e2e fixture'`;

export const orders = table`
  CREATE TABLE ${app}.orders (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status text NOT NULL DEFAULT 'placed',
    amount numeric(12, 2) NOT NULL
  )`;

export const ordersStatus = index`
  CREATE INDEX orders_status_idx ON ${orders} (${orders.columns.status})`;
