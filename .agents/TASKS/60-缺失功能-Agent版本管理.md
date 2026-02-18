# TASK-60: Agent 版本管理系统

## 优先级: P1 — 数据模型已规划，Agent 管理核心能力

## PRD

[Agent 版本管理系统](../PRDS/missing-agent-versioning.md)

## 描述

DATA_MODEL.md 规划了 `agent_versions` 表，当前 version 字段仅用于乐观锁，无版本历史。需要实现版本快照、历史查询、版本回滚。

## 涉及文件

- 新增 `docs/sql/017_agent_versions.sql`
- 新增 `apps/api/src/repositories/agent-version.repository.ts`
- 修改 `apps/api/src/services/agent.service.ts` — update 方法中创建版本快照
- 修改 `apps/api/src/routes/v1/agents.ts` — 新增版本相关端点
- 修改 `packages/shared-types/src/agent.ts` — 新增 AgentVersion 类型

## 修复方式

1. 创建 `agent_versions` 表（id, agent_id, org_id, version_number, snapshot JSONB, change_summary, created_at, created_by）
2. 在 `agent.service.ts` 的 update 方法中，更新前将当前配置快照写入 agent_versions
3. 新增 API 端点：GET /agents/:id/versions、GET /agents/:id/versions/:vn、POST /agents/:id/versions/:vn/rollback
4. 回滚操作生成新版本而非覆盖历史

## 验收标准

- [ ] Agent 更新时自动创建版本快照
- [ ] 版本历史列表可查询（分页）
- [ ] 指定版本详情可查看
- [ ] 回滚功能正常，生成新版本
- [ ] 单元测试覆盖

## 状态: 待处理
