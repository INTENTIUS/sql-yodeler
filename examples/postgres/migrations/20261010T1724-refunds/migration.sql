-- yodel migration 20261010T1724-refunds
-- parent: 20261010T1723-coupons

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN refunded_at timestamp with time zone;

-- ordersRefundedAt (shop.orders_refunded_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_refunded_at_idx ON shop.orders (refunded_at);

-- ordersRefundedAt (shop.orders_refunded_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_refunded_at_idx IS '[chant managed-by=chant]';
