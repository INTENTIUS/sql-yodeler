-- yodel migration 20261010T0440-add-source
-- parent: 20261010T0440-fill-country

-- events (shop.events): SQLCH201 metadata
ALTER TABLE `shop`.`events` ADD COLUMN source LowCardinality(String) DEFAULT 'web' AFTER `country`;
