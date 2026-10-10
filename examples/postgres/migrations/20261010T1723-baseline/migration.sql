-- yodel migration 20261010T1723-baseline
-- parent: none (the first migration)

-- shopSchema (shop): SQLPG200 create
CREATE SCHEMA shop;

-- shopSchema (shop): SQLPG200 create
COMMENT ON SCHEMA shop IS 'The SQL Yodeler Postgres example [chant managed-by=chant]';

-- orders (shop.orders): SQLPG200 create
CREATE TABLE shop.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_email text NOT NULL,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT orders_pkey PRIMARY KEY (id)
  );

-- orders (shop.orders): SQLPG200 create
COMMENT ON TABLE shop.orders IS '[chant managed-by=chant]';

-- ordersStatusIdx (shop.orders_status_idx): SQLPG200 create
CREATE INDEX orders_status_idx ON shop.orders USING btree (status);

-- ordersStatusIdx (shop.orders_status_idx): SQLPG200 create
COMMENT ON INDEX shop.orders_status_idx IS '[chant managed-by=chant]';
