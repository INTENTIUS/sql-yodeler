-- yodel migration 20261009T2038-drop-coupon
-- parent: 20261009T2038-rename-email

-- orders (yodel_18_shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE yodel_18_shop.orders DROP COLUMN coupon;
