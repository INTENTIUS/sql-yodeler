-- yodel migration 20261010T0533-index-placed-at
-- parent: 20261010T0533-add-gift

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON shop.orders (placed_at);

-- ordersPlacedAt (shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX shop.orders_placed_at_idx IS '[chant managed-by=chant]';
