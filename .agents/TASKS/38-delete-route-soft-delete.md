# TASK-38: DELETE 路由改用软删除

## 优先级: P0 — 立即修复

## PRD

[skill-repo-data-integrity.md](../PRDS/skill-repo-data-integrity.md)

## 描述

`routes/v1/skill-definitions.ts:278` 的 DELETE 路由调用了 `skillDefinitionRepo.remove(id)` 物理删除方法，应改为 `softDelete(id)`。

## 涉及文件

- `apps/api/src/routes/v1/skill-definitions.ts` L278

## 修复方式

```typescript
// ❌ 当前
await skillDefinitionRepo.remove(id)

// ✅ 修复
const deleted = await skillDefinitionRepo.softDelete(id)
if (!deleted) {
  res.status(404).json({
    success: false,
    error: { code: 'SKILL_NOT_FOUND', message: '技能定义不存在或已删除' },
  })
  return
}
```

## 验收标准

- [ ] DELETE 路由调用 `softDelete()` 而非 `remove()`
- [ ] 软删除后数据仍存在于数据库（is_active = false）
- [ ] 返回 404 当技能不存在或已删除

## 状态: 待处理
