// examples/computed/src/orders.ts
import { table } from "@intentius/chant-lexicon-sql/postgres";
import { params } from "@intentius/chant/params";
import { RegionalPartitions } from "../lib/regional.js";
import { shop } from "./schema.js";

const fillfactor = params.tier === "large" ? "70" : "100";

export const orders = table<"shop.orders">`
  CREATE TABLE ${shop}.orders (
    id     bigint NOT NULL,
    region text NOT NULL,
    at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, region)
  ) PARTITION BY LIST (region) WITH (fillfactor = ${fillfactor})`;

export const regions = RegionalPartitions({ parent: orders, regions: ["eu", "us", "apac"] });
