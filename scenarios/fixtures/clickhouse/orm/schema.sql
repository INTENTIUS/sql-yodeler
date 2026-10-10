-- The DDL an ORM prints for its models (here in the form a ClickHouse
-- SQLAlchemy dialect's CreateTable gives), standing in for running the
-- ORM: names unqualified. The declarative claim's ORM part reads it
-- through a DDL source.

CREATE TABLE customers (
    id UInt64,
    email String,
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE invoices (
    id UInt64,
    customer_id UInt64,
    total Decimal(12, 2)
)
ENGINE = MergeTree
ORDER BY (customer_id, id);
