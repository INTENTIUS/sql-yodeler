-- yodel migration 20261010T0518-coupons
-- parent: 20261010T0518-baseline

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN coupon text;

-- orders (shop.orders): SQLPG217 metadata
ALTER TABLE shop.orders ADD CONSTRAINT orders_amount_positive CHECK (amount > 0) NOT VALID;
