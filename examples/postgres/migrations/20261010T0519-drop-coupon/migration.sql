-- yodel migration 20261010T0519-drop-coupon
-- parent: 20261010T0518-rename-email

-- orders (shop.orders): SQLPG204 metadata, destructive
-- yodel:allow destructive no order ever had a coupon; checked on dev
ALTER TABLE shop.orders DROP COLUMN coupon;
