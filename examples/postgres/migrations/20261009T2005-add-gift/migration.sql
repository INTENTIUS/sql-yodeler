-- yodel migration 20261009T2005-add-gift
-- parent: 20261009T2004-drop-coupon

-- orders (yodel_18_shop.orders): SQLPG201 metadata
ALTER TABLE yodel_18_shop.orders ADD COLUMN gift boolean DEFAULT false NOT NULL;
