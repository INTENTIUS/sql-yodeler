-- yodel migration 20261010T0258-rename-email
-- parent: 20261010T0257-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (yodel_18_shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (yodel_18_shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-yodel-18-shop-orders-email", env: "<env>", table: "yodel_18_shop.orders", column: "email" });
