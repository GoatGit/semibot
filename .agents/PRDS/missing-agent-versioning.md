# PRD: Agent 版本管理系统

## 背景

DATA_MODEL.md 规划了 `agent_versions` 表，支持 Agent 配置的版本历史追踪和回滚。当前 Agent 表的 `version` 字段仅用于乐观锁，没有版本历史记录机制，用户无法查看配置变更历史或回滚到之前版本。

## 功能需求

### 1. 版本快照

- Agent 每次更新时自动创建版本快照
- 记录完整的配置变更（模型配置、技能列表、MCP 服务器、系统提示词等）
- 版本号自增（v1, v2, v3...）

### 2. 版本历史查询

- 查看 Agent 的所有历史版本列表
- 查看指定版本的完整配置
- 对比两个版本之间的差异（diff）

### 3. 版本回滚

- 支持回滚到指定历史版本
- 回滚操作本身也生成新版本（不覆盖历史）
- 回滚前检查依赖兼容性（如引用的技能/MCP 是否仍存在）

## 技术方案

### 数据模型

```sql
CREATE TABLE agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  org_id UUID NOT NULL,
  version_number INT NOT NULL,
  snapshot JSONB NOT NULL,
  change_summary TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by UUID NOT NULL,
  UNIQUE(agent_id, version_number)
);

CREATE INDEX idx_agent_versions_agent_id ON agent_versions(agent_id, version_number DESC);
```

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/v1/agents/:id/versions | 版本历史列表 |
| GET | /api/v1/agents/:id/versions/:versionNumber | 获取指定版本 |
| POST | /api/v1/agents/:id/versions/:versionNumber/rollback | 回滚到指定版本 |

### 涉及文件

- 新增 `apps/api/src/repositories/agent-version.repository.ts`
- 修改 `apps/api/src/services/agent.service.ts` — update 时创建版本快照
- 修改 `apps/api/src/routes/v1/agents.ts` — 新增版本相关端点
- 新增 `docs/sql/017_agent_versions.sql`
- 修改 `packages/shared-types/src/agent.ts` — 新增 AgentVersion 类型

## 优先级

**P1 — 数据模型已规划，Agent 管理的核心能力**

## 验收标准

- [ ] Agent 更新时自动创建版本快照
- [ ] 版本历史列表可查询（分页）
- [ ] 指定版本详情可查看
- [ ] 回滚功能正常工作
- [ ] 回滚生成新版本而非覆盖
- [ ] 版本快照包含完整配置
- [ ] 单元测试覆盖
