import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const shopSchema = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example'`;

export const orders = table`
  CREATE TABLE ${shopSchema}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL, -- previously: customer_email
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      refunded_at timestamp with time zone,
      gift boolean DEFAULT false NOT NULL,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersStatusIdx = index`
  CREATE INDEX orders_status_idx ON ${orders} USING btree (status)`;

export const ordersPlacedAt = index`
  CREATE INDEX CONCURRENTLY orders_placed_at_idx ON ${orders} (placed_at)`;
