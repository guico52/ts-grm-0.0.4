// 最小复现：ts-grm 0.0.4 的继承 JOIN 问题
// 场景：Child extends Base；查询子类时一旦 select / where 到继承字段（基类字段），
//       生成的 SQL 就会 inner join 基类表（joined-table inheritance），
//       即使该基类表在真实数据库（由外部 DDL，如 Prisma）中并不存在。
// 对照：只查询子类自身字段时不 join 基类表。
// 说明：join 逻辑位于 @ts-grm/sql 的驱动无关公共层（_addJoinByInheritance），
//       所有数据库驱动行为一致，与 PostgreSQL 的表继承（INHERITS）特性无关。
import { test } from "node:test";
import assert from "node:assert/strict";
import { model, prop, dto } from "@ts-grm/core";
import { PostgresDriver, newSqlClient } from "@ts-grm/sql";

// ---------- 最小模型：Child extends Base ----------
const Base = model("Base", "id", class {
    id = prop.str(36)
    createdAt = prop.date()
    updatedAt = prop.date()
}, ctx => ctx.table({ discriminator: "ENTITY_TYPE", discriminatorValue: "Base" }));

const Child = model.extends(Base)("Child", class {
    name = prop.str(36)
}, ctx => ctx.table({ discriminatorValue: "Child" }));

// ---------- 最小命名策略（camelCase → lower_snake_case，表名 = 模型名小写） ----------
const namingStrategy = {
    tableName: (entity) => entity.name.toLowerCase(),
    sequenceName: () => "",
    columnName: (prop) => prop.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
    middleTableName: (prop) => `${prop.name}_mapping`,
    middleTableThisRefColumnName: () => "this_id",
    middleTableTargetRefColumnName: () => "target_id",
};

// ---------- 拦截 SQL 的最小客户端（不连真实数据库） ----------
function makeClient() {
    const records = [];
    const fakePool = {
        connect: async () => ({
            query: async () => { throw new Error("拦截器不应转发到真实查询"); },
            release: () => {},
        }),
    };
    const client = newSqlClient(
        new PostgresDriver(fakePool),
        {
            strategy: namingStrategy,
            executorCreator: () => ({
                execute: async () => {},
                executeStatement: async (sql) => {
                    records.push(sql);
                    return [];
                },
                executeStatements: async () => [],
            }),
        },
    );
    return { client, records };
}

test("对照：只查询子类自身字段 → 不 JOIN 基类表", async () => {
    const { client, records } = makeClient();
    const view = dto.view(Child, (c) => [c.id, c.name]);
    await client.createQuery(Child, (q, c) => {
        q.where(c.name.eq("x"));
        return q.select(c.fetch(view));
    }).fetchList();
    const sql = records[0];
    console.log("[场景1] select 子类自身字段:\n" + sql);
    assert.ok(sql, "应生成 SQL");
    assert.ok(!/join/i.test(sql), "不应 JOIN 基类表");
});

test("复现：select 继承字段 createdAt → JOIN 基类表 base", async () => {
    const { client, records } = makeClient();
    const view = dto.view(Child, (c) => [c.id, c.name, c.createdAt]);
    await client.createQuery(Child, (q, c) => {
        q.where(c.name.eq("x"));
        return q.select(c.fetch(view));
    }).fetchList();
    const sql = records[0];
    console.log("[场景2] select 继承字段 createdAt:\n" + sql);
    assert.ok(sql, "应生成 SQL");
    assert.ok(/join/i.test(sql), "生成了对基类表的 JOIN（问题复现）");
    assert.ok(/join\s+\w*base\w*\s+/i.test(sql), "JOIN 的目标是基类表 base");
});

test("复现：where 继承字段 createdAt → 同样 JOIN 基类表", async () => {
    const { client, records } = makeClient();
    const view = dto.view(Child, (c) => [c.id, c.name]);
    await client.createQuery(Child, (q, c) => {
        q.where(c.createdAt.gt(new Date("2024-01-01")));
        return q.select(c.fetch(view));
    }).fetchList();
    const sql = records[0];
    console.log("[场景3] where 继承字段 createdAt:\n" + sql);
    assert.ok(sql, "应生成 SQL");
    assert.ok(/join/i.test(sql), "生成了对基类表的 JOIN（问题复现）");
});
