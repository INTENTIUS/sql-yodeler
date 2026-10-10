-- yodel migration 20261010T1725-add-gift
-- parent: 20261010T1724-drop-coupon

-- orders (shop.orders): SQLPG201 metadata
ALTER TABLE shop.orders ADD COLUMN gift boolean DEFAULT false NOT NULL;
