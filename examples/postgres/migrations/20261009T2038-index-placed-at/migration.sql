-- yodel migration 20261009T2038-index-placed-at
-- parent: 20261009T2038-add-gift

-- ordersPlacedAt (yodel_18_shop.orders_placed_at_idx): SQLPG240 concurrently, outside a transaction
CREATE INDEX CONCURRENTLY orders_placed_at_idx ON yodel_18_shop.orders (placed_at);

-- ordersPlacedAt (yodel_18_shop.orders_placed_at_idx): SQLPG240 concurrently
COMMENT ON INDEX yodel_18_shop.orders_placed_at_idx IS '[chant managed-by=chant]';
