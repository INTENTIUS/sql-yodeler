-- yodel migration 20261010T0438-add-country
-- parent: 20261010T0438-baseline

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
