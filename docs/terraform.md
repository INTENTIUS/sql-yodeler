---
claims: [approval]
type: howto
---

# Running yodel alongside Terraform

Terraform and yodel each own one layer. Terraform creates the server, the database or schema, and the users yodel connects as. yodel owns everything inside: the tables, views and functions, their migrations, and the history of what was applied. The pipeline runs `terraform apply` first and `yodel apply <env>` after it.

## What Terraform creates

For each environment, Terraform creates:

- the database (ClickHouse) or schema (Postgres) the project declares, and the one yodel keeps its history in,
- a reader user, which can read and nothing else,
- a writer user, which can change the schema and write the history,
- the secrets holding both users' passwords, where the pipeline reads them.

yodel refuses an environment whose reader and writer are the same user ([Credentials: a reader and a writer](configuration.md#credentials-a-reader-and-a-writer)).

On Postgres, with the `postgresql` provider:

```hcl
resource "random_password" "reader" { length = 32 }
resource "random_password" "writer" { length = 32 }

resource "postgresql_role" "writer" {
  name     = "app_writer"
  login    = true
  password = random_password.writer.result
}

resource "postgresql_role" "reader" {
  name     = "app_reader"
  login    = true
  password = random_password.reader.result
}

# The writer owns the declared schema and the history schema.
resource "postgresql_schema" "app" {
  name  = "app"
  owner = postgresql_role.writer.name
}

resource "postgresql_schema" "history" {
  name  = "yodeler"
  owner = postgresql_role.writer.name
}

resource "postgresql_grant" "reader_usage" {
  database    = "postgres"
  role        = postgresql_role.reader.name
  schema      = postgresql_schema.app.name
  object_type = "schema"
  privileges  = ["USAGE"]
}

resource "postgresql_default_privileges" "reader_select" {
  database    = "postgres"
  role        = postgresql_role.reader.name
  owner       = postgresql_role.writer.name
  schema      = postgresql_schema.app.name
  object_type = "table"
  privileges  = ["SELECT"]
}
```

The reader needs the same `USAGE` and default `SELECT` on the history schema, so `yodel status` and `yodel drift` can read it.

On ClickHouse, the users are created with SQL by whatever provisions the server, once per environment:

```sql
CREATE USER app_writer IDENTIFIED WITH sha256_password BY '<writer password>';
CREATE USER app_reader IDENTIFIED WITH sha256_password BY '<reader password>' SETTINGS readonly = 1;
CREATE DATABASE events;
CREATE DATABASE yodeler;
GRANT ALL ON events.* TO app_writer;
GRANT ALL ON yodeler.* TO app_writer;
GRANT SELECT, SHOW ON events.* TO app_reader;
GRANT SELECT, SHOW ON yodeler.* TO app_reader;
```

Terraform then writes each password into the secret store the pipeline reads: the forge's secrets, or a cloud secret manager. The variable names yodel reads are `<ENV>_<DIALECT>_READER_USER`, `<ENV>_<DIALECT>_READER_PASSWORD`, `<ENV>_<DIALECT>_WRITER_USER` and `<ENV>_<DIALECT>_WRITER_PASSWORD`, for example `PROD_POSTGRES_WRITER_PASSWORD`. [Setting up each forge](forges.md) says where each forge keeps them.

## The pipeline

The infrastructure job runs first, and the apply wave `yodel ci` renders runs after it:

1. `terraform apply` creates or updates the server, the database or schema, and the users.
2. `yodel apply <env>` applies the pending migrations, behind the approval bound to the plan digest ([Approval](approval.md)).

On a pull request, `terraform plan` and `yodel plan` each post their own plan. A reviewer approves the schema change with `yodel approve <env>`; the infrastructure change follows your Terraform review as before.

## Where each tool's state lives

- Terraform state holds the server, the database or schema, the users and their grants.
- yodel's history table holds every migration applied to each environment, with its checksum, the plan digest it was approved under, who applied it, and each statement's outcome. A failed apply resumes from it.

Neither tool reads the other's state. Terraform never declares the tables, so a schema change never shows as Terraform drift, and `yodel drift` reports only the objects `src/` declares.

## Why the schema apply is its own step

A schema change waits for a person's approval of its exact plan, and resumes from yodel's history when it stops part way. Inside `terraform apply` it would either hold Terraform's run open for that approval or apply without it, and Terraform state would become a second record of the schema. Keeping `yodel apply` as its own step keeps one record and one approval.

The same holds when the cluster runs the deploy: [Applying from Kubernetes](kubernetes.md) runs `yodel apply <env>` as a Job after the infrastructure is in place.
