import { index, schema, table, view } from "@intentius/chant-lexicon-sql/postgres";

export const shop = schema`
  CREATE SCHEMA shop;
  COMMENT ON SCHEMA shop IS 'Customers and their orders'`;

export const customers = table`
  CREATE TABLE ${shop}.customers (
      id bigint GENERATED ALWAYS AS IDENTITY,
      email text NOT NULL,
      CONSTRAINT customers_pkey PRIMARY KEY (id),
      CONSTRAINT customers_email_key UNIQUE (email)
  );
  COMMENT ON TABLE shop.customers IS 'One row per customer';
  COMMENT ON COLUMN shop.customers.email IS 'Lower-cased'`;

export const orders = table`
  CREATE TABLE ${shop}.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_id bigint NOT NULL,
      amount numeric(12,2) NOT NULL,
      CONSTRAINT orders_pkey PRIMARY KEY (id),
      CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES ${customers} (id) ON DELETE CASCADE,
      CONSTRAINT orders_amount_positive CHECK (amount > 0)
  )`;

export const ordersCustomer = index`
  CREATE INDEX orders_customer_idx ON ${orders} (customer_id)`;

export const bigOrders = view`
  CREATE VIEW ${shop}.big_orders
  WITH (security_invoker = true) AS
  SELECT id, customer_id, amount FROM ${orders} WHERE amount > 1000`;
