# PRD: Skill 模块多租户隔离策略

## 背景

2026-02 全面审查发现 `skill_definitions` 表没有 `org_id` 字段，所有查询无租户隔离。需要明确 skill 模块的多租户策略。

## 现状

- `skill_definitions` 表无 `org_id` 列
- `findAll()` 返回所有数据，无租户过滤
- `findById()` / `update()` / `softDelete()` 无 org_id 校验
- 写入路由通过 `requirePermission('admin')` 限制，但读取路由对所有认证用户开放

## 需要决策

### 方案 A：全局共享资源（当前隐含行为）

skill_definitions 是平台级资源，所有租户共享。

- 优点：简单，符合"技能市场"概念
- 缺点：需要在代码和文档中明确标注
- 行动：添加代码注释说明、在 API 文档中标注

### 方案 B：租户隔离

每个租户有自己的 skill_definitions。

- 优点：符合项目多租户隔离规范
- 缺点：需要加 org_id 列、迁移数据、修改所有查询
- 行动：新增迁移脚本、修改 repository 所有方法

### 方案 C：混合模式

平台预置 skill 全局可见 + 租户自定义 skill 隔离。

- 优点：灵活
- 缺点：查询逻辑复杂
- 行动：加 org_id 列（nullable），查询时 `WHERE org_id = $1 OR org_id IS NULL`

## 关联模块

- `skill_packages` — 跟随 skill_definitions 的隔离策略
- `skill_install_logs` — 跟随 skill_definitions 的隔离策略
- `requirePermission('admin')` vs `requireRole('admin')` 语义需同步确认

## 优先级

P1 — 需要产品决策后实施

## 验收标准

- [ ] 多租户策略已确认并文档化
- [ ] 代码实现与策略一致
- [ ] 如选方案 B/C，所有查询包含 org_id 过滤
