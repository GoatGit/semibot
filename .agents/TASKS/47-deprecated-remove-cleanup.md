# TASK-47: @deprecated remove() 方法清理

## 优先级: P2

## PRD

[skill-repo-data-integrity.md](../PRDS/skill-repo-data-integrity.md)

## 描述

`skill-definition.repository.ts` 和 `skill-package.repository.ts` 的 `remove()` 方法标记了 `@deprecated`，但仍可被调用（skill-definitions 路由实际在调用它）。应移除这些方法或标记为内部方法，防止误用。

## 涉及文件

- `apps/api/src/repositories/skill-definition.repository.ts` — `remove()` L249-256
- `apps/api/src/repositories/skill-package.repository.ts` — `remove()` L297-304
- `apps/api/src/routes/v1/skill-definitions.ts` — L278 调用 `remove()`

## 行动项

1. 路由改用 `softDelete()`（TASK-38）
2. 确认无其他调用方后删除 `remove()` 方法
3. 如有其他调用方，先迁移到 `softDelete()`

## 依赖

- TASK-38（DELETE 路由改用软删除）

## 验收标准

- [ ] `remove()` 方法已删除或无调用方
- [ ] 所有删除操作使用 `softDelete()`

## 状态: 待处理
