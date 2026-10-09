import { postgres, postgresReachable, SCHEMA } from "./emulator.js";
import { declarativeSuite } from "./declarative.js";

declarativeSuite({
  dialect: "postgres",
  reachable: postgresReachable,
  reset: async () => {
    await postgres(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  },
  tableExists: async () => (await postgres<{ t: string | null }>(`SELECT to_regclass('${SCHEMA}.orders')::text AS t`))[0]?.t != null,
  declared: 3,
  addColumn: ["    amount numeric(12, 2) NOT NULL\n", "    amount numeric(12, 2) NOT NULL,\n    note   text\n"],
  changeColumn: ["    note   text\n", "    note   text DEFAULT 'none'\n"],
  needsOp: ["status text NOT NULL DEFAULT 'placed'", "status integer NOT NULL DEFAULT 0"],
  foreign: async () => {
    await postgres(`CREATE TABLE ${SCHEMA}.handmade (x int)`);
  },
  changeOutOfBand: async () => {
    await postgres(`ALTER TABLE ${SCHEMA}.orders ALTER COLUMN status SET DEFAULT 'new'`);
    return { name: "orders", path: /default/ };
  },
  dropOutOfBand: async () => {
    await postgres(`DROP INDEX ${SCHEMA}.orders_status_idx`);
    return "ordersStatus";
  },
});
