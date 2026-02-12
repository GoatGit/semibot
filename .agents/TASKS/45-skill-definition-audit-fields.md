# TASK-45: skill-definition 审计字段补全

## 优先级: P2

## PRD

[skill-repo-data-integrity.md](../PRDS/skill-repo-data-integrity.md)

## 描述

`SkillDefinitionRow` 缺少 `updated_by`、`deleted_at`、`deleted_by` 审计字段，不符合项目数据库规范。当前软删除仅设置 `is_active = false`，不记录删除人和删除时间。

## 涉及文件

- `apps/api/src/repositories/skill-definition.repository.ts` — 类型定义和查询
- `database/migrations/` — 需要新增迁移脚本添加字段

## 行动项

1. 新增迁移脚本：添加 `updated_by`、`deleted_at`、`deleted_by` 列
2. 更新 `SkillDefinitionRow` 类型
3. 更新 `softDelete()` 方法使用 `deleted_at` + `deleted_by`
4. 更新所有查询添加 `deleted_at IS NULL` 过滤

## 验收标准

- [ ] 迁移脚本幂等
- [ ] 软删除记录删除人和时间
- [ ] 查询默认过滤已删除记录

## 状态: 待处理
