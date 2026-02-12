# TASK-36: SQL 注入漏洞修复

## 优先级: P0 — 立即修复

## PRD

[security-sql-injection-fix.md](../PRDS/security-sql-injection-fix.md)

## 描述

三个 repository 的 `findAll()`、`count()`、`getLatest()` 方法使用字符串拼接 + `sql.unsafe()` 构建 WHERE 条件，存在 SQL 注入风险。

## 涉及文件

- `apps/api/src/repositories/skill-install-log.repository.ts`
  - `findAll()` L170, 174, 178
  - `count()` L256, 260, 264
  - `getLatest()` L285
- `apps/api/src/repositories/skill-package.repository.ts`
  - `findAll()` L215, 219
  - `count()` L316, 320
- `apps/api/src/repositories/skill-definition.repository.ts`
  - `count()` L264-265

## 修复方式

将字符串拼接替换为 postgres.js tagged template 条件片段：

```typescript
const conditions = []
if (options.status) {
  conditions.push(sql`status = ${options.status}`)
}
const where = conditions.length > 0
  ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
  : sql``
```

## 验收标准

- [ ] 所有动态 WHERE 条件使用参数化查询
- [ ] 移除所有 `sql.unsafe()` 调用
- [ ] 现有功能正常（findAll 分页、count 统计、getLatest 查询）
- [ ] TypeScript 编译通过

## 状态: 待处理
