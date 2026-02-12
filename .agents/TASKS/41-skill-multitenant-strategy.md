# TASK-41: Skill 模块多租户隔离策略确认

## 优先级: P1 — 需要产品决策

## PRD

[skill-multitenant-isolation.md](../PRDS/skill-multitenant-isolation.md)

## 描述

`skill_definitions` 表没有 `org_id` 字段，所有查询无租户隔离。需要产品侧确认 skill 模块的多租户策略：

- **方案 A**: 全局共享资源 — 添加代码注释和文档说明
- **方案 B**: 租户隔离 — 加 org_id 列，修改所有查询
- **方案 C**: 混合模式 — org_id nullable，平台预置 + 租户自定义

## 涉及文件

- `apps/api/src/repositories/skill-definition.repository.ts`
- `apps/api/src/repositories/skill-package.repository.ts`
- `apps/api/src/repositories/skill-install-log.repository.ts`
- `apps/api/src/routes/v1/skill-definitions.ts`
- `database/migrations/` — 方案 B/C 需要新增迁移

## 行动项

1. 与产品确认多租户策略
2. 根据决策实施对应方案
3. 更新 API 文档

## 验收标准

- [ ] 多租户策略已确认并文档化
- [ ] 代码实现与策略一致

## 状态: 待处理（等待产品决策）
