# TASK-39: skill-definition findAll 参数化查询修复

## 优先级: P1

## PRD

[security-sql-injection-fix.md](../PRDS/security-sql-injection-fix.md)

## 描述

`skill-definition.repository.ts` 的 `findAll()` 方法（L158-193）构建了 `params` 数组和 `$1` 占位符，但 `sql.unsafe(whereClause)` 不处理这些占位符。postgres.js 的 `sql.unsafe()` 不接受参数绑定，导致 search（ILIKE）功能实际不工作或运行时报错。

## 涉及文件

- `apps/api/src/repositories/skill-definition.repository.ts` L146-201

## 修复方式

与 TASK-36 相同，改用 postgres.js tagged template 条件片段：

```typescript
const conditions = []
if (options.isActive !== undefined) {
  conditions.push(sql`is_active = ${options.isActive}`)
}
if (options.isPublic !== undefined) {
  conditions.push(sql`is_public = ${options.isPublic}`)
}
if (options.search) {
  conditions.push(sql`(name ILIKE ${'%' + options.search + '%'} OR description ILIKE ${'%' + options.search + '%'})`)
}
```

## 验收标准

- [ ] findAll 的 search 功能正常工作
- [ ] isActive / isPublic 过滤正常
- [ ] 分页正常
- [ ] TypeScript 编译通过

## 状态: 待处理
