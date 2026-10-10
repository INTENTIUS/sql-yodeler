# sql-yodeler-example-clickhouse: entity relationships

From chant build of the declared schema. Written by `yodel docs`; index.html next to this file has every object's columns, keys, engine and history.

```mermaid
erDiagram
  shop_events["shop.events"] {
    UInt64 id PK
    LowCardinality(String) kind PK
    DateTime at
    LowCardinality(String) country
    LowCardinality(String) source
  }
```
