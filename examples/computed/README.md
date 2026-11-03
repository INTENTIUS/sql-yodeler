# Computed schema example

A Postgres schema computed from TypeScript, built with no server:

- `lib/regional.ts` is a composite that takes a list of regions and returns one `PARTITION OF` table and one index per region.
- `src/orders.ts` declares the partitioned `orders` table, calls the composite with three regions, and takes the table's `fillfactor` from the `tier` build parameter declared in `chant.config.ts`.

```sh
npm run build                                                # fillfactor = 100
npx chant build src --lexicon sql --param tier=large -o dist/schema.json   # fillfactor = 70
```

[Declaring the schema](../../docs/schema.md#computing-the-schema) explains the example. `test/computed-example.test.ts` builds it both ways.
