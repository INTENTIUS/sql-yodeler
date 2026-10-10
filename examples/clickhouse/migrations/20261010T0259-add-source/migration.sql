-- yodel migration 20261010T0259-add-source
-- parent: 20261010T0259-fill-country

-- events (yodel_18_shop.events): SQLCH201 metadata
ALTER TABLE `yodel_18_shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`;
