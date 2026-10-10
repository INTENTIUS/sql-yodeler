-- yodel migration 20261009T2309-coupons
-- parent: 20261009T2308-baseline

-- orders (yodel_18_shop.orders): SQLPG201 metadata
ALTER TABLE yodel_18_shop.orders ADD COLUMN coupon text;

-- orders (yodel_18_shop.orders): SQLPG217 metadata
ALTER TABLE yodel_18_shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
