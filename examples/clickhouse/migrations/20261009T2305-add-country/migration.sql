-- yodel migration 20261009T2305-add-country
-- parent: 20261009T2305-baseline

-- events (yodel_18_shop.events): SQLCH201 metadata
ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN country LowCardinality(String) DEFAULT '' AFTER `at`;
