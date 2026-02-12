# TASK-42: requirePermission 语义修正

## 优先级: P1

## PRD

[skill-multitenant-isolation.md](../PRDS/skill-multitenant-isolation.md)

## 描述

路由中使用 `requirePermission('admin')` 限制管理员操作，但 `requirePermission` 检查的是 `user.permissions` 数组中是否包含 `'admin'` 字符串，而非检查用户角色。

如果意图是"仅管理员角色可操作"，应使用 `requireRole('admin', 'owner')`。
如果意图是"拥有 admin 权限的用户可操作"，则当前实现正确，但需要确认 permissions 数组中确实会包含 `'admin'` 值。

## 涉及文件

- `apps/api/src/routes/v1/skill-definitions.ts` — 多处使用 `requirePermission('admin')`
- `apps/api/src/middleware/auth.ts` — `requirePermission` 和 `requireRole` 实现

## 行动项

1. 确认 `requirePermission('admin')` 的意图
2. 如果是角色检查，替换为 `requireRole('admin', 'owner')`
3. 审查其他路由是否有同样问题

## 验收标准

- [ ] 权限检查语义明确
- [ ] 管理员操作确实只有管理员能执行

## 状态: 待处理
