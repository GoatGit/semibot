# PRD: 前端 API Hooks 补充

## 概述

前端缺少大量模块的 API 调用封装，后端已实现完整的 REST API，但前端只有 `useSession` 和 `useChat` 两个 Hook。

## 问题描述

以下后端 API 在前端没有对应的 Hook 或调用封装：

| 模块 | 后端路由 | 前端状态 |
|------|---------|---------|
| Agents | `/api/v1/agents` | ❌ 缺失 |
| Skills | `/api/v1/skills` | ❌ 缺失 |
| Tools | `/api/v1/tools` | ❌ 缺失 |
| MCP Servers | `/api/v1/mcp` | ❌ 缺失 |
| Memory | `/api/v1/memory` | ❌ 缺失 |
| Logs | `/api/v1/logs` | ❌ 缺失 |
| Organizations | `/api/v1/organizations` | ❌ 缺失 |
| API Keys | `/api/v1/api-keys` | ❌ 缺失 |

## 目标

1. 为每个后端模块创建对应的前端 Hook
2. 统一状态管理模式（参考 `useSession.ts`）
3. 支持加载状态、错误处理、分页

## 技术方案

### 1. 创建 Hooks 目录结构

```
apps/web/hooks/
├── useAgent.ts        # Agent CRUD + 列表管理
├── useSkill.ts        # Skill CRUD
├── useTool.ts         # Tool CRUD
├── useMcp.ts          # MCP Server 管理 + 测试连接
├── useMemory.ts       # Memory 管理 + 向量搜索
├── useLogs.ts         # 日志查询（只读）
├── useOrganization.ts # 组织信息 + 成员管理
└── useApiKeys.ts      # API Key 管理
```

### 2. Hook 模板模式

```typescript
// 参考 useSession.ts 的模式
export interface UseAgentReturn {
  state: AgentState
  loadAgents: (options?: LoadOptions) => Promise<void>
  createAgent: (input: CreateAgentInput) => Promise<Agent>
  updateAgent: (id: string, input: UpdateAgentInput) => Promise<Agent>
  deleteAgent: (id: string) => Promise<void>
  selectAgent: (id: string) => Promise<void>
}
```

### 3. 共享类型同步

确保前端 Hook 的输入/输出类型与 `@semibot/shared-types` 保持一致。

## 验收标准

- [ ] 8 个模块的 Hook 全部实现
- [ ] 每个 Hook 支持 CRUD 操作（如适用）
- [ ] 统一的加载状态和错误处理
- [ ] 分页支持（使用 meta 字段）
- [ ] TypeScript 类型完整
- [ ] 单元测试覆盖

## 优先级

**P1 - 高优先级** - 阻碍前端功能开发

## 相关文件

- `apps/web/hooks/useSession.ts` (参考模板)
- `apps/web/lib/api.ts` (API 客户端)
- `packages/shared-types/src/` (共享类型)
