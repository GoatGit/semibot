# PRD: Skill Repository 数据完整性修复

## 背景

2026-02 全面审查发现 skill 相关 repository 存在多项数据完整性问题：JSONB 双重序列化、物理删除路由、审计字段缺失、类型定义重复。

## 问题清单

### 1. JSONB 双重序列化 (P0)

`skill-install-log.repository.ts:88`：

```typescript
// ❌ 违反项目规范
const metadata = JSON.stringify({ version: data.version })
```

应改为 `sql.json()`。

### 2. DELETE 路由调用物理删除 (P0)

`routes/v1/skill-definitions.ts:278`：

```typescript
// ❌ 调用了 @deprecated 的物理删除方法
await skillDefinitionRepo.remove(id)
```

应改为 `skillDefinitionRepo.softDelete(id)`。

### 3. skill-definition 缺少审计字段 (P1)

`SkillDefinitionRow` 缺少：
- `updated_by` — 更新人
- `deleted_at` / `deleted_by` — 软删除审计

当前软删除仅设置 `is_active = false`，不符合项目统一的 `deleted_at` 软删除规范。

### 4. version 存储在 metadata JSONB 中 (P2)

`skill-install-log` 的 `version` 字段存在 `metadata` JSONB 内而非独立列，读取时从 `metadata.version` 提取。如果 version 是高频查询/过滤字段，应提升为独立列。

### 5. @deprecated 方法未清理 (P2)

`skill-definition.repository.ts` 和 `skill-package.repository.ts` 的 `remove()` 方法标记了 `@deprecated`，但仍被路由调用或可被调用。应移除或设为 private。

## 影响范围

- `apps/api/src/repositories/skill-install-log.repository.ts`
- `apps/api/src/repositories/skill-definition.repository.ts`
- `apps/api/src/repositories/skill-package.repository.ts`
- `apps/api/src/routes/v1/skill-definitions.ts`
- `database/migrations/` — 可能需要新增迁移脚本

## 优先级

P0 (JSONB + 物理删除) / P1 (审计字段) / P2 (version 列、deprecated 清理)

## 验收标准

- [ ] 所有 JSONB 写入使用 `sql.json()`
- [ ] DELETE 路由改用 `softDelete()`
- [ ] `remove()` 方法从路由调用中移除
- [ ] 审计字段方案确认（是否需要迁移脚本）
