/**
 * yodel test (#54) for the example's migrations: the backfill and the
 * rebuild with rows in the table, run on the replay profile's throwaway
 * server (yodel test --env replay). Each expectation is one of
 * { kind: "rows" | "value" | "error", sql, ... }; the package's
 * expectRows, expectValue and expectError make the same objects.
 */
import type { TestCase } from "@intentius/sql-yodeler";

const addCountry = "20261010T0528-add-country";
const eventsById = "20261010T0528-events-by-id";

export default [
  {
    name: "fill-country fills the country of each event in the months it covers, from the id",
    at: eventsById,
    seed: ["INSERT INTO shop.events (id, kind, at) VALUES (1, 'view', '2026-06-03 10:00:00'), (2, 'click', '2026-07-14 11:00:00'), (3, 'view', '2026-11-30 23:00:00')"],
    expect: [{ kind: "rows", sql: "SELECT id, country FROM shop.events ORDER BY id", rows: [[1, "FR"], [2, "US"], [3, "DE"]] }],
  },
  {
    name: "an event outside those months keeps an empty country",
    at: eventsById,
    seed: ["INSERT INTO shop.events (id, kind, at) VALUES (4, 'view', '2026-01-02 09:00:00')"],
    expect: [{ kind: "value", sql: "SELECT country FROM shop.events WHERE id = 4", value: "" }],
  },
  {
    name: "the rebuild keeps every event and sorts them by kind and id",
    at: addCountry,
    through: eventsById,
    seed: ["INSERT INTO shop.events (id, kind, at) VALUES (5, 'view', '2026-06-03 10:00:00'), (6, 'click', '2026-06-04 10:00:00')"],
    expect: [
      { kind: "value", sql: "SELECT count() FROM shop.events", value: 2 },
      { kind: "value", sql: "SELECT sorting_key FROM system.tables WHERE database = 'shop' AND name = 'events'", value: "kind, id" },
    ],
  },
] satisfies TestCase[];
