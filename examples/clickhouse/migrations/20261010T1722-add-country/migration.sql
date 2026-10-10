-- yodel migration 20261010T1722-add-country
-- parent: 20261010T1722-baseline

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
