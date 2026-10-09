-- yodel migration 20261009T2003-baseline
-- parent: none (the first migration)

-- yodel18ShopSchema (yodel_18_shop): SQLPG200 create
CREATE SCHEMA yodel_18_shop;

-- yodel18ShopSchema (yodel_18_shop): SQLPG200 create
COMMENT ON SCHEMA yodel_18_shop IS 'The SQL Yodeler Postgres example [chant managed-by=chant]';

-- orders (yodel_18_shop.orders): SQLPG200 create
CREATE TABLE yodel_18_shop.orders (
      id bigint GENERATED ALWAYS AS IDENTITY,
      customer_email text NOT NULL,
      status text DEFAULT 'placed'::text NOT NULL,
      amount numeric(12,2) NOT NULL,
      placed_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT orders_pkey PRIMARY KEY (id)
  );

-- orders (yodel_18_shop.orders): SQLPG200 create
COMMENT ON TABLE yodel_18_shop.orders IS '[chant managed-by=chant]';

-- ordersStatusIdx (yodel_18_shop.orders_status_idx): SQLPG200 create
CREATE INDEX orders_status_idx ON yodel_18_shop.orders USING btree (status);

-- ordersStatusIdx (yodel_18_shop.orders_status_idx): SQLPG200 create
COMMENT ON INDEX yodel_18_shop.orders_status_idx IS '[chant managed-by=chant]';
