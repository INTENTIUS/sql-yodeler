-- yodel migration 20261010T0519-add-gift
-- parent: 20261010T0519-drop-coupon

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN gift boolean DEFAULT false NOT NULL;
