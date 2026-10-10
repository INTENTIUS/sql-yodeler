/**
 * yodel test (#54) for the example's migrations: the column rename with
 * rows in the table, and the constraint and default the newest migration
 * leaves, run on the replay profile's throwaway server (yodel test --env
 * replay). Each expectation is one of { kind: "rows" | "value" | "error",
 * sql, ... }; the package's expectRows, expectValue and expectError make
 * the same objects.
 */
import type { TestCase } from "@intentius/sql-yodeler";

export default [
  {
    name: "rename-email keeps every order's email",
    at: "20261010T0532-validate-amount",
    seed: ["INSERT INTO shop.orders (customer_email, amount) VALUES ('a@example.com', 10), ('b@example.com', 20)"],
    through: "20261010T0532-rename-email",
    expect: [{ kind: "rows", sql: "SELECT email FROM shop.orders ORDER BY id", rows: [["a@example.com"], ["b@example.com"]] }],
  },
  {
    name: "orders_amount_positive refuses an order of 0",
    expect: [{ kind: "error", sql: "INSERT INTO shop.orders (email, amount) VALUES ('c@example.com', 0)", match: "orders_amount_positive" }],
  },
  {
    name: "an order is not a gift unless it says so",
    expect: [{ kind: "rows", sql: "INSERT INTO shop.orders (email, amount) VALUES ('d@example.com', 5) RETURNING gift", rows: [[false]] }],
  },
] satisfies TestCase[];
