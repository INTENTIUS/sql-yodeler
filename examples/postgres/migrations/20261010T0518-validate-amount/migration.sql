-- yodel migration 20261010T0518-validate-amount
-- parent: 20261010T0518-coupons

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- orders (shop.orders): SQLPG220 validate
ALTER TABLE shop.orders VALIDATE CONSTRAINT orders_amount_positive;
