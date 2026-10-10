-- yodel migration 20261010T0518-rename-email
-- parent: 20261010T0518-validate-amount
-- This migration contains an Op step, not only SQL:
--   PostgresMigrationOp for orders (shop.orders), SQLPG205: not SQL; migration.json holds its declaration

-- orders (shop.orders): SQLPG205 made by PostgresMigrationOp, not a statement:
--   export const { op } = PostgresMigrationOp({ name: "migrate-shop-orders-email", env: "<env>", table: "shop.orders", column: "email" });
