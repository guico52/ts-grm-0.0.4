# ts-grm-0.0.4：继承模型查询 JOIN 基类表复现

复现 ts-grm 0.0.4（npm 官方包）的继承实现问题：

- **场景**：`Child extends Base`，查询子类时一旦 **select / where 到继承字段**（基类字段，
  如 `createdAt`），生成的 SQL 就会 `inner join` 基类表。
- **预期**：继承字段应内联在子表（single-table / mapped-superclass 语义，Jimmer 即如此），
  查询不产生 JOIN——尤其当数据库由外部 DDL（如 Prisma）以单表平铺方式建表时，
  基类表根本不存在，任何触及继承字段的查询都会直接失败。
- **实际**：ts-grm 的继承是 ORM 层的 **joined-table inheritance（JTI）**——基类字段落在
  独立基类表，查询时以 `on 子表.id = 基表.id` 组装：

  ```sql
  select tb_1_.id, tb_1_.name, tb_2_.created_at
  from child tb_1_
  inner join base tb_2_ on tb_1_.id = tb_2_.id
  ```

- **边界**：只查询子类自身字段（含继承来的 `id`）时不 JOIN；一旦触碰继承字段即 JOIN。

## 运行

```bash
npm install   # 安装 @ts-grm/core@0.0.4 + @ts-grm/sql@0.0.4
npm test
```

预期：三个测试均通过（场景 1 断言不 JOIN；场景 2/3 断言 JOIN 发生并打印 SQL）。

## 最小复现（约 10 行）

```js
import { model, prop, dto } from "@ts-grm/core";
import { PostgresDriver, newSqlClient } from "@ts-grm/sql";

const Base = model("Base", "id", class {
    id = prop.str(36)
    createdAt = prop.date()
}, ctx => ctx.table({ discriminator: "ENTITY_TYPE", discriminatorValue: "Base" }));

const Child = model.extends(Base)("Child", class {
    name = prop.str(36)
}, ctx => ctx.table({ discriminatorValue: "Child" }));

// select 继承字段 createdAt：
// → from child inner join base on child.id = base.id（基类表 base 不存在时查询失败）
```

## 分析（供对照）

1. **不是 PostgreSQL 表继承（INHERITS）**：`@ts-grm/sql` 全部 7 个驱动
   （Sqlite/Postgres/MySQL/Oracle/SQLServer）中没有出现任何 `INHERITS` 语法，
   JOIN 生成逻辑位于驱动无关的公共层（`_addJoinByInheritance`），
   所有数据库行为一致。
2. **继承被建模为"隐式外键 + JOIN"**：`createSchema` 为每个继承层建独立表，
   继承关系用隐式外键表达（`-- Implicit foreign key constraint for inheritance`），
   这是典型的 JTI（joined-table inheritance）。
3. **Jimmer 的对照**：Jimmer 的 `@MappedSuperclass` 把基类字段**内联**到子表
   （single-table 语义），查询子类不产生 JOIN；Jimmer 官方测试
   `PermissionBase`（映射超类声明 `@ManyToOne Role`）即为此模式。
   ts-grm 作为移植，继承语义与 Jimmer 不一致。
4. **对"外部 DDL 建库"场景的影响**：数据库由 Prisma 等外部工具以单表建好时，
   没有基类表；此时 ts-grm 的继承 JOIN 必然产生
   `relation "base" does not exist` 之类的运行时错误。

## 建议修复方向（给上游）

- 提供 **single-table inheritance（STI）**：基类字段内联到子表，查询不 JOIN；
- 或提供配置项关闭继承 JOIN（继承字段直接按子表列处理），兼容外部建表；
- 或至少让继承策略可配置（JTI / STI 二选一）。

环境：Node >= 20（ESM）。
