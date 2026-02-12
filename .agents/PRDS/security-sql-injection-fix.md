# PRD: SQL 注入漏洞修复

## 背景

2026-02 全面审查发现，`skill-install-log`、`skill-package`、`skill-definition` 三个 repository 的 `findAll()`、`count()`、`getLatest()` 方法使用字符串拼接 + `sql.unsafe()` 构建 WHERE 条件，存在 SQL 注入风险。

## 问题详情

### 1. skill-install-log.repository.ts

`findAll()` (L170, 174, 178) 和 `count()` (L256, 260, 264) 和 `getLatest()` (L285)：

```typescript
// ❌ 直接将用户输入拼接进 SQL
conditions.push(`skill_definition_id = '${options.skillDefinitionId}'`)
conditions.push(`status = '${options.status}'`)
conditions.push(`operation = '${options.operation}'`)
// 然后通过 sql.unsafe(whereClause) 执行
```

### 2. skill-package.repository.ts

`findAll()` (L215, 219) 和 `count()` (L316, 320)：

```typescript
conditions.push(`status = '${options.status}'`)
conditions.push(`source_type = '${options.sourceType}'`)
```

### 3. skill-definition.repository.ts

`findAll()` (L158-193)：使用了 `$1` 占位符语法，但 params 数组未传给 `sql.unsafe()`，占位符不会被替换，功能实际不工作。

`count()` (L264-265)：直接拼接布尔值到 SQL。

## 修复方案

使用 postgres.js 的 tagged template 动态条件拼接替代 `sql.unsafe()` + 字符串拼接：

```typescript
// ✅ 正确方式：使用 postgres.js 的条件片段
const conditions = []

if (options.status) {
  conditions.push(sql`status = ${options.status}`)
}

if (options.skillDefinitionId) {
  conditions.push(sql`skill_definition_id = ${options.skillDefinitionId}`)
}

const where = conditions.length > 0
  ? sql`WHERE ${conditions.reduce((a, b) => sql`${a} AND ${b}`)}`
  : sql``

const rows = await sql<Row[]>`
  SELECT * FROM table_name
  ${where}
  ORDER BY created_at DESC
  LIMIT ${pageSize} OFFSET ${offset}
`
```

## 影响范围

- `apps/api/src/repositories/skill-install-log.repository.ts` — findAll, count, getLatest
- `apps/api/src/repositories/skill-package.repository.ts` — findAll, count
- `apps/api/src/repositories/skill-definition.repository.ts` — findAll, count

## 优先级

**P0 — 立即修复**

## 验收标准

- [ ] 所有动态 WHERE 条件使用参数化查询，不存在字符串拼接
- [ ] 移除所有 `sql.unsafe()` 调用（或仅用于静态 SQL 片段）
- [ ] findAll 的 search/filter 功能正常工作
- [ ] 现有单元测试通过
