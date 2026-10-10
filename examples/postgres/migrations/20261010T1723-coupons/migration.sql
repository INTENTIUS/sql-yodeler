-- yodel migration 20261010T1723-coupons
-- parent: 20261010T1723-baseline

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN coupon text;

-- orders (shop.orders): SQLPG217 metadata
-- pre-check, must return 0 (rows that fail the check orders_amount_positive (amount > 0)): SELECT count(*) AS n FROM shop.orders WHERE NOT (amount > 0)
ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;

-- orders (shop.orders): SQLPG220 validate
ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive;
