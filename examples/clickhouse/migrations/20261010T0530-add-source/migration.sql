-- yodel migration 20261010T0530-add-source
-- parent: 20261010T0530-fill-country

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`;
