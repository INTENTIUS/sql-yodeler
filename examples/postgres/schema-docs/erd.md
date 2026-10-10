# sql-yodeler-example-postgres: entity relationships

From chant build of the declared schema. Written by `yodel docs`; index.html next to this file has every object's columns, keys, engine and history.

```mermaid
erDiagram
  shop_orders["shop.orders"] {
    bigint id PK
    text email
    text status
    numeric(12_2) amount
    timestamp_with_time_zone placed_at
    timestamp_with_time_zone refunded_at
    boolean gift
  }
```
