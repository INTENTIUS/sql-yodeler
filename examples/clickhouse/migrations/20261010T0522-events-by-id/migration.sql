-- yodel migration 20261010T0522-events-by-id
-- parent: 20261010T0521-add-country
-- This migration contains an Op step, not only SQL:
--   ClickHouseRebuildOp for events (shop.events), SQLCH220: not SQL; migration.json holds its declaration

-- yodel:allow ch-rebuild 600 rows; the copy takes seconds
-- events (shop.events): SQLCH220 made by ClickHouseRebuildOp, not a statement:
--   export const { op } = ClickHouseRebuildOp({ name: "rebuild-shop-events", env: "<env>", table: "shop.events", dualWrite: { mode: "materialized-view", cutoverColumn: "at" } });
