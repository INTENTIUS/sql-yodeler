-- yodel migration 20261010T0257-add-country
-- parent: 20261010T0257-baseline

-- events (yodel_18_shop.events): SQLCH201 metadata
ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
