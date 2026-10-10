---
claims: [declarative, adopt]
---

# Access control

Who can read and write what is part of the schema. chant's sql lexicon declares it next to the tables it is about. On Postgres that is row-level security on a table, policies, the roles the schema needs, grants and revokes, and default privileges. On ClickHouse it is users, roles, row policies and grants ([ClickHouse](#clickhouse) below). yodel plans and applies those declarations like the rest of the schema, shows them under review with their rules and classes, and adopts the ones a database already has.

```ts
import { grant, policy, role, table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./schema.js";

export const reader = role`CREATE ROLE app_reader NOLOGIN`;

export const tickets = table`
  CREATE TABLE ${app}.tickets (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant text NOT NULL,
    title  text NOT NULL
  );
  ALTER TABLE ${app}.tickets ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ${app}.tickets FORCE ROW LEVEL SECURITY`;

export const ticketsByTenant = policy`
  CREATE POLICY tickets_tenant ON ${tickets} FOR SELECT TO ${reader}
  USING (${tickets.columns.tenant} = current_setting('app.tenant'))`;

export const useApp = grant`GRANT USAGE ON SCHEMA ${app} TO ${reader}`;
export const readTickets = grant`GRANT SELECT ON ${tickets} TO ${reader}`;
export const editTitles = grant`GRANT UPDATE (title) ON ${tickets} TO support`;
```

chant's page on access (`postgres-access` in the sql lexicon's docs) has the declarations' full syntax and how privileges are compared.

## Turn it on per environment

Access is off until an environment turns it on, on either dialect, so a project whose access is managed somewhere else sees no change. Set it in `yodel.config.ts`:

```ts
export default defineConfig({
  environments: {
    dev: { access: true },
    prod: { access: true },
  },
});
```

The first one set wins: `environments.<env>.access` in `yodel.config.ts`, then chant's `sql.profiles.<env>.access` in `chant.config.ts`, then off. yodel hands the result to chant for everything it runs itself: `yodel plan`, `yodel new`'s plan, `yodel init --from` and the server reads of the versioned path.

On the declarative path, the apply is the project's `ApplyOp` run by `chant run`, and `yodel drift` runs `chant lifecycle diff`. Both read `chant.config.ts` themselves, so there `yodel.config.ts` must agree with the profile. yodel refuses otherwise rather than plan one thing and apply another:

```text
yodel plan: yodel.config.ts sets environments.dev.access to true, but the declarative path applies through chant, which reads sql.profiles.dev.access in chant.config.ts (unset, so off). Set sql.profiles.dev.access to true as well, or leave access to chant.config.ts.
```

On Postgres, with access off, the access declarations are left out of the plan (chant's hint counts them), the server's policies and privileges are not read, and a table is created without its `ROW LEVEL SECURITY` statements. With access on, the declared privileges are all the privileges on the declared objects: one granted by hand is revoked by the next apply.

The same holds on ClickHouse: with access off, chant leaves the users, roles, row policies and grants out of the plan and the apply and does not read the server's, and `yodel drift` lists each access declaration as not compared.

## What the schema owns and what the environment owns

This section and the next three are about Postgres; ClickHouse has [its own](#clickhouse).

The schema owns these, declared and kept as declared:

- row-level security on a table, and `FORCE ROW LEVEL SECURITY`;
- policies;
- privileges on the declared schemas, tables, views, sequences, columns, functions and procedures;
- default privileges of the role that applies (and of a role named with `FOR ROLE`);
- the roles the schema itself needs, such as a `NOLOGIN` role that carries privileges. They are created when missing and are never dropped.

The environment owns these, and they are never declared:

- Passwords. `PASSWORD` in `CREATE ROLE` is refused. Set a role's password wherever the environment keeps its credentials; a migration file, a plan comment or the history never holds one.
- Memberships: who is in which role. `IN ROLE`, `ROLE`, `ADMIN` and `GRANT role TO role` are refused. They differ per environment, and the platform usually provisions login roles and their memberships.
- Roles the environment provisions. A declaration names one as text where it grants to it (`TO support`); yodel never creates, reads or drops it. A grant to a role the server does not have fails in the apply, naming it.
- Who owns an object.

## Under review

`yodel plan` on the declarative path ends with an access section: every access change with its rule and class, and whether access is managed in the environment and where that is set. A revoke that no `REVOKE` declaration asks for takes away a privilege granted by hand (or one whose declaration was deleted). It changes what a role can do once the apply runs, so the plan lists it on its own:

```text
Access control (managed in dev, from yodel.config.ts): 1 change
  SQLPG297 metadata  relation app.tickets TO app_reader  privileges: insert, select -> select  (granted by hand)

Revoked by this apply, though no declaration revokes it: privileges granted by hand (or whose declaration was deleted). The role loses it once the apply runs:
  relation app.tickets FROM app_reader: insert
To keep it, declare it with grant`...`.
```

`yodel plan --json` has the same under `access`: `managed`, `source`, and `changes`, a revoke of a hand-made grant marked `byHand: true`. The apply prints the section before it runs. Its gate binds the digest of chant's `lifecycle diff`, which observes policies and roles but not privileges, so an approval on the declarative path does not cover a privilege granted or revoked by hand after it: the apply makes the privileges match the declarations whatever changed in between. On the versioned path every statement, grants and revokes included, is in the migration's checksum and so in the digest the approval binds.

On the versioned path, `yodel new` writes each access change as a statement with its rule and class (SQLPG200 for a role or policy created with its table, SQLPG290 to SQLPG298 otherwise), and prints how many steps are about access and which of them take access away. `yodel plan` and the pull request comment list the same under each pending migration.

| Rule | Change | Class |
|---|---|---|
| SQLPG290 | A policy created on an existing table | metadata |
| SQLPG291 | A policy changed | metadata |
| SQLPG292 | A policy dropped | drop |
| SQLPG293 | Row-level security turned on or off, or forced | metadata |
| SQLPG294 | A role's attributes changed | metadata |
| SQLPG296 | A privilege granted | metadata |
| SQLPG297 | A privilege revoked | metadata |
| SQLPG298 | Default privileges changed | metadata |

## Lint and the gate

Two lint rules read access steps ([Lint](lint.md)):

- `pg-access` (an error, silenceable): a statement that takes access away. That is a revoke, a dropped policy, or row-level security turned off or no longer forced. A revoke on an object the same migration creates, such as `REVOKE EXECUTE ... FROM PUBLIC` on a new function, takes nothing from anyone and is not flagged.
- `pg-rls-not-forced` (a warning, silenceable): a migration that enables a table's row-level security while its recorded schema does not force it. Postgres does not hold a table's owner to its policies unless the table forces them, and the owner is usually the role that applies migrations.

A wave with gate `on-destructive` waits on a `pg-access` step as it waits on a drop ([Approval](approval.md#waves-a-gate-per-environment)).

## Adopting a database

With access on for the environment, `yodel init --from <env>` adopts each table's row-level security with the table, the policies, and the privileges as `grant` declarations. Each declaration is the `GRANT` or `REVOKE` that takes a new object's privileges to what the server holds, so the adoption plans as no change. Roles are the environment's and are not adopted; the grants name them as text. The baseline migration records the policies and grants with the rest, and nothing is sent to the server.

## ClickHouse

On ClickHouse the access declarations are `user`, `role`, `policy` (a row policy) and `grant`, from `@intentius/chant-lexicon-sql/clickhouse`:

```ts
import { grant, policy, role, user } from "@intentius/chant-lexicon-sql/clickhouse";
import { events } from "./schema.js";

export const reader = role`CREATE ROLE app_reader SETTINGS max_threads = 4`;
export const dashboards = user`CREATE USER dashboards DEFAULT ROLE ${reader}`;

export const clicksOnly = policy`CREATE ROW POLICY clicks ON ${events} FOR SELECT USING kind = 'click' TO ${reader}`;

export const readEvents = grant`GRANT SELECT ON ${events} TO ${reader}`;
export const dashboardsRead = grant`GRANT ${reader} TO ${dashboards}`;
```

chant's page on ClickHouse access (`clickhouse-access` in the sql lexicon's docs) has the full syntax and how each is compared.

What the schema owns and what the environment owns:

- A password is the environment's. `IDENTIFIED BY` is refused in a declaration. A user declared without `IDENTIFIED`, like `dashboards` above, is not created by chant: the apply reports it as not attempted and its grants as waiting on it until the environment creates the user with its password; from then on the apply keeps the rest of it (its default role, host, settings) as declared and leaves the password alone. A user declared with a method that holds no secret (`NOT IDENTIFIED`, `ssl_certificate`, `ldap`, `kerberos`, `http`, `ssh_key`) is created by chant.
- Grants are compared per grantee. All the `grant` declarations naming a grantee are everything it holds: anything else it holds is revoked by the next apply, and there is no `REVOKE` declaration.
- Users, roles and row policies are created and changed, never dropped. None of them carries chant's ownership marker, so a plan reads only the ones the build declares, and one made by hand is never seen.

### Under review

`yodel plan` and `yodel apply` on the declarative path end with the same access section as on Postgres. Every revoke on ClickHouse takes away something no declaration grants, so each one is called out:

```text
Access control (managed in dev, from yodel.config.ts): 1 change
  SQLCH274 metadata  grants app_reader  grants.INSERT ON shop.events: INSERT ON shop.events -> nothing  (granted by hand)

Revoked by this apply, though no declaration revokes it: privileges granted by hand (or whose declaration was deleted). The role loses it once the apply runs:
  INSERT ON shop.events FROM app_reader
To keep it, declare it with grant`...`.
```

`yodel drift` reports the same grant: chant's `lifecycle diff` reads users, roles and row policies but leaves grants unobserved, so yodel compares each declared grantee's grants itself and lists a grant held by hand, a declared grant that is missing, and a grantee that is gone.

On the versioned path `yodel new` writes the access statements with their rules and classes, prints how many steps are about access and which take it away, and `yodel plan` and the pull request comment list the same under each pending migration.

| Rule | Change | Class |
|---|---|---|
| SQLCH200 | A user, role or row policy created, or a grantee's first grants | create |
| SQLCH270 | A role's settings changed (`ALTER ROLE`) | metadata |
| SQLCH271 | A user's clause changed (one `ALTER USER` per clause) | metadata |
| SQLCH272 | A row policy changed (`CREATE ROW POLICY OR REPLACE`) | metadata |
| SQLCH273 | A privilege or role granted | metadata |
| SQLCH274 | A privilege or role revoked | metadata |

`ch-access` (an error, silenceable) flags a revoke, and a wave with gate `on-destructive` waits on it ([Lint](lint.md)).

### Topology and replay

None of these objects belongs to a database. In the `cluster` topology, and in `replicated` when it names a cluster, their statements are sent `ON CLUSTER` (`CREATE USER ... ON CLUSTER`, `GRANT ON CLUSTER ...`); inside a `Replicated` database alone they are sent to the node, since its log does not carry them ([Topology](topology.md)).

`yodel lint --replay` empties the databases it replays into, and also drops the functions, users, roles and row policies the history declares, which outlive a database. A user the history declares without `IDENTIFIED` is the environment's to create, so the replay creates it with a random password before the first statement, and gives it its declared clauses before each migration is compared.

### Adopting

With access on for the environment, `yodel init --from <env>` writes `src/access.ts` beside the import's `schema.ts`:

- every row policy on a table in the profile's `databases`;
- each user or role holding a privilege in those databases, each role a policy applies to, and each user or role those roles are granted to, but not the server's `default` user;
- for each of them, its `CREATE USER` (without its authentication) or `CREATE ROLE`, and all of its grants as `grant` declarations, not only those in the databases, since a grantee's grants are compared as a whole.

A grantee with a partial revoke (`REVOKE` in `SHOW GRANTS`) cannot be declared and is left out with a warning. The baseline records the grants with the rest, and nothing is sent to the server. With access off, init adopts the databases, tables, views, dictionaries and functions alone.
