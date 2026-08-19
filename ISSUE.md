# [BUG] - Querying an inherited (base-class) field generates a JOIN to the base table (joined-table inheritance) — no single-table option, incompatible with externally-created schemas

> Submit at: <https://github.com/babyfish-ct/ts-grm/issues/new>
>
> Structured after the field layout of the Jimmer repo's `bug_report.yml` template (ts-grm has no `.github` template yet, so the issue is formatted manually).
> Suggested label: `bug`.

---

### ts-grm Version

`@ts-grm/core` 0.0.4 + `@ts-grm/sql` 0.0.4 (npm latest)

### Node Version

Node v20+ (ESM, any recent LTS)

### Database

Driver-agnostic. The repro intercepts SQL through the `executorCreator` hook with a fake pool — no real database is touched. The behavior is identical across all built-in drivers (`SqliteDriver` / `PostgresDriver` / `MySqlDriver` / `OracleDriver` / `SqlServerDriver`), because the JOIN is produced in the driver-independent layer (`_addJoinByInheritance`). It is **not** related to PostgreSQL table inheritance (`INHERITS`).

### OS

Linux

### Expected behavior

Querying a subclass that extends a base model should **not** JOIN the base table. Base-class (inherited) fields should be resolvable as columns of the subclass table — the single-table / mapped-superclass semantics that Jimmer provides (`@MappedSuperclass` inlines base fields into the child table; the official test `jimmer-sql/.../inheritance/PermissionBase.java` covers a mapped superclass declaring `@ManyToOne Role`). This matters especially when the database is created by external DDL (e.g. Prisma) as flat single tables: no base table exists, so any query touching an inherited field fails at runtime.

### Actual behavior

Whenever a query **selects or filters on an inherited (base-class) field**, ts-grm generates an `inner join` to the base table:

```sql
-- select inherited field createdAt
select tb_1_.id, tb_1_.name, tb_2_.created_at
from child tb_1_
inner join base tb_2_ on tb_1_.id = tb_2_.id
where tb_1_.name = $1

-- where inherited field createdAt
select tb_1_.id, tb_1_.name
from child tb_1_
inner join base tb_2_ on tb_1_.id = tb_2_.id
where tb_2_.created_at > $1
```

Querying only subclass-declared fields (including the inherited `id`) does **not** JOIN:

```sql
select tb_1_.id, tb_1_.name from child tb_1_ where tb_1_.name = $1
```

### Description

**Scenario**: `Child extends Base`, `Base` declares `id`/`createdAt`/`updatedAt`, `Child` declares `name`.

**Root cause**: ts-grm models inheritance as **joined-table inheritance (JTI)** at the ORM level:
- `createSchema` (`_processEntity`) creates a separate table per inheritance level, and the inheritance link is expressed as an implicit foreign key (`-- Implicit foreign key constraint for inheritance`). The generated DDL is self-consistent JTI:
  ```sql
  create table base(id text not null, ENTITY_TYPE text not null, created_by text not null, updated_by text not null)
  create table child(id text not null, name text not null)
  alter table child add constraint child_constraint_2 foreign key(id) references base(id) on delete cascade
  ```
- query compilation (`_addJoinByInheritance` in `@ts-grm/sql`, driver-independent) emits `inner join <base-table> on <child>.id = <base>.id` whenever an inherited property is referenced.

This is a deliberate but **single-strategy** implementation: there is no single-table inheritance (STI) option that inlines base fields into the child table.

**Why this breaks real-world usage**: when the schema is created by external DDL (Prisma, plain SQL, etc.) as flat tables — which is the natural shape for this kind of inheritance — the base table does not exist. Any query that touches `createdAt`/`createdBy`/`enterpriseId` (i.e. almost every real query on an inherited model) fails with `relation "base" does not exist`.

**Impact on `createSchema` (init SQL)**: the same JTI strategy shows up in DDL generation. `client.createSchema()` produces a separate base table plus a child table linked by an inheritance foreign key, instead of a single flat table:

```sql
create table base(id text not null, ENTITY_TYPE text not null, created_by text not null, updated_by text not null)
create table child(id text not null, name text not null)
alter table child add constraint child_constraint_2 foreign key(id) references base(id) on delete cascade
```

So the incompatibility is bidirectional: (a) external single-table DDL + ts-grm queries → JOIN to a non-existent base table; (b) ts-grm-generated init SQL → a two-table JTI shape that contradicts the single-table assumption of Prisma/other ORMs. Repro test (4) asserts this DDL.

**Not PostgreSQL-specific**: no driver in `@ts-grm/sql` uses the PostgreSQL `INHERITS` syntax; the JOIN is generated identically for SQLite/PostgreSQL/MySQL/Oracle/SQL Server.

**Suggested fix**:
1. Add a **single-table inheritance (STI)** mode: base-class fields are emitted as columns of the child table and queries never JOIN;
2. or make the inheritance strategy configurable (JTI / STI), so schemas created externally (single-table shape) can opt out of the JOIN;
3. or at minimum, allow disabling the inheritance JOIN so inherited fields are read as plain child-table columns.

### Reproduction steps

```bash
git clone https://github.com/guico52/ts-grm-0.0.4.git
cd ts-grm-0.0.4
npm install   # installs only @ts-grm/core@0.0.4 + @ts-grm/sql@0.0.4
npm test
```

The repro package contains four tests: (1) control — selecting only subclass fields produces no JOIN; (2) selecting an inherited field produces a JOIN to the base table; (3) filtering on an inherited field also produces a JOIN; (4) `createSchema` generates a separate base table plus a child table linked by an inheritance foreign key (JTI DDL). All four print the generated SQL/DDL to the console.

### Relation Model

```ts
const Base = model("Base", "id", class {
    id = prop.str(36)
    createdAt = prop.date()
    updatedAt = prop.date()
}, ctx => ctx.table({ discriminator: "ENTITY_TYPE", discriminatorValue: "Base" }));

const Child = model.extends(Base)("Child", class {
    name = prop.str(36)
}, ctx => ctx.table({ discriminatorValue: "Child" }));
```

### Generated SQL

```sql
-- [1] control: select subclass-only fields → no JOIN
select tb_1_.id, tb_1_.name from child tb_1_ where tb_1_.name = $1

-- [2] select inherited field createdAt → JOIN base
select tb_1_.id, tb_1_.name, tb_2_.created_at
from child tb_1_
inner join base tb_2_ on tb_1_.id = tb_2_.id
where tb_1_.name = $1

-- [3] where inherited field createdAt → JOIN base
select tb_1_.id, tb_1_.name
from child tb_1_
inner join base tb_2_ on tb_1_.id = tb_2_.id
where tb_2_.created_at > $1
```

### Screenshots

N/A

### Logs

N/A (no crash at model level — the issue manifests in the generated SQL; full output is printed by the repro tests)

### Notes

- Repro package (with all three test cases): <https://github.com/guico52/ts-grm-0.0.4>
- Repro package README (includes the Jimmer / PostgreSQL `INHERITS` comparison): <https://github.com/guico52/ts-grm-0.0.4/blob/main/README.md>
