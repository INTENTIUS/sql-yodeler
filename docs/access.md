---
claims: [declarative, adopt]
---

# Access control

On Postgres, who can read and write which rows is part of the schema. chant's sql lexicon declares it next to the tables it is about: row-level security on a table, policies, the roles the schema needs, grants and revokes, and default privileges. yodel plans and applies those declarations like the rest of the schema, shows them under review with their rules and classes, and adopts the ones a database already has.

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

Access is off until an environment turns it on, so a project whose access is managed somewhere else sees no change. Set it in `yodel.config.ts`:

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

With access off, the access declarations are left out of the plan (chant's hint counts them), the server's policies and privileges are not read, and a table is created without its `ROW LEVEL SECURITY` statements. With access on, the declared privileges are all the privileges on the declared objects: one granted by hand is revoked by the next apply.

## What the schema owns and what the environment owns

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

`yodel plan --json` has the same under `access`: `managed`, `source`, and `changes`, a revoke of a hand-made grant marked `byHand: true`. The apply prints the section before it runs, and its gate binds the plan, so a privilege granted by hand after the approval changes the digest and the apply asks again.

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
