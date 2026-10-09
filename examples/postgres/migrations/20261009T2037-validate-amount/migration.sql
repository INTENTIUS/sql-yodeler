-- yodel migration 20261009T2037-validate-amount
-- parent: 20261009T2037-coupons

-- orders (yodel_18_shop.orders): SQLPG201 metadata
ALTER TABLE yodel_18_shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- orders (yodel_18_shop.orders): SQLPG220 validate
ALTER TABLE yodel_18_shop.orders VALIDATE CONSTRAINT orders_amount_positive;
