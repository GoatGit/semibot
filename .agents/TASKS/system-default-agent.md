# 系统默认 Agent + 系统预装能力继承 — 任务拆解

> **状态: ⬜ 待实施（0/7 Tasks）**

## Context

当前系统没有"默认 Agent"概念。前端 `/chat/new` 不选 Agent 时 fallback 到列表第一个，后端要求 `agentId` 必传。同时，系统预装的 tools/mcps/skills 没有自动继承机制——Agent 必须手动关联才能使用。

本方案引入：
1. 一个全局唯一的系统默认 Agent（org_id=NULL），不选 Agent 时自动使用
2. 系统预装能力（is_system/is_builtin 标记的 tools/mcps/skills）自动被所有 Agent 继承

## 核心设计决策

- 系统默认 Agent 使用 well-known UUID `00000000-0000-0000-0000-000000000001`
- `org_id = NULL` 表示系统级资源，对所有组织可见
- `is_system = true` 标记系统级 Agent/MCP，受写保护（禁止修改/删除）
- 系统能力合并策略：系统能力 + Agent 专属能力，按 ID 去重，系统能力优先

## 与 AGENT_RUNTIME.md 设计对照

本方案已对照 `docs/design/AGENT_RUNTIME.md` 验证架构兼容性，结论：**整体符合，无结构性冲突**。

符合点：
- 核心状态机（START→PLAN→ACT/DELEGATE→OBSERVE→REFLECT→RESPOND）不受影响，系统 Agent 走同一套执行流程
- Tool/Skill 三层能力模型不变，系统能力合并发生在 API 层组装 `RuntimeInputState` 时，Runtime 内部不感知
- SubAgent 委派兼容，系统 Agent 自然进入候选池
- LLM 适配层、记忆系统、监控指标均无影响

需注意的 2 点：

### 1. 多租户隔离边界变化

`org_id = NULL` 局部突破了"所有查询必须包含 org_id"的原则。实施时必须确保：
- 系统 Agent 的执行日志（execution_logs）和用量计量（usage_logs）归属到**调用者的 org_id**，而非 NULL
- 系统 Agent 的配置缓存 key 不要按 org_id 隔离（否则每个 org 缓存一份相同数据），建议用 `system:agent:{id}` 格式

### 2. 系统能力合并时机

设计文档中 `create_agent_graph(agent_config)` 接收完整配置，Runtime 内部不再查数据库加载额外能力。因此系统能力的合并**必须在 API 层完成**（chat.service.ts 组装 RuntimeInputState 时），不能依赖 Runtime 侧。当前方案已正确处理此点。

## 任务依赖

```
Task 0 (DB) → Task 1 (Types) → Task 2 (Repo) → Task 3 (Service) → Task 4 (能力继承) + Task 5 (Routes) → Task 6 (Frontend)
```

## 涉及文件清单

| 文件 | 操作 |
|------|------|
| `database/migrations/013_system_default_agent.sql` | 新建 |
| `apps/api/src/constants/config.ts` | 修改 |
| `apps/api/src/constants/errorCodes.ts` | 修改 |
| `packages/shared-types/src/agent.ts` | 修改 |
| `apps/api/src/repositories/agent.repository.ts` | 修改 |
| `apps/api/src/repositories/mcp.repository.ts` | 修改 |
| `apps/api/src/services/agent.service.ts` | 修改 |
| `apps/api/src/services/mcp.service.ts` | 修改 |
| `apps/api/src/services/chat.service.ts` | 修改 |
| `apps/api/src/routes/v1/agents.ts` | 修改 |
| `apps/api/src/routes/v1/chat.ts` | 修改 |
| `apps/api/src/routes/v1/sessions.ts` | 修改 |
| `apps/web/app/(dashboard)/chat/new/page.tsx` | 修改 |

---

## Task 0: 数据库 Migration ⬜

新建 `database/migrations/013_system_default_agent.sql`

**改动**:

1. `agents` 表新增 `is_system` 列：
   ```sql
   ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
   ```

2. `agents.org_id` 改为 nullable（系统 Agent 无 org）：
   ```sql
   ALTER TABLE agents ALTER COLUMN org_id DROP NOT NULL;
   ```

3. `mcp_servers` 表新增 `is_system` 列：
   ```sql
   ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
   ```

4. `mcp_servers.org_id` 改为 nullable：
   ```sql
   ALTER TABLE mcp_servers ALTER COLUMN org_id DROP NOT NULL;
   ```

5. 系统 Agent 唯一约束（全局只能有一个 is_system=true 的 Agent）：
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_system ON agents(is_system) WHERE is_system = true;
   ```

6. 系统 MCP 唯一名称约束：
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_system_name ON mcp_servers(name) WHERE is_system = true;
   ```

7. Seed 系统默认 Agent：
   ```sql
   INSERT INTO agents (id, org_id, name, description, system_prompt, config, skills, sub_agents, is_system, is_active, is_public)
   VALUES (
     '00000000-0000-0000-0000-000000000001',
     NULL,
     '系统助手',
     '系统默认 AI 助手，可使用所有系统预装能力',
     'You are a helpful AI assistant with access to system tools and capabilities.',
     '{"model":"gpt-4o","temperature":0.7,"maxTokens":4096,"timeoutSeconds":120}',
     '{}',
     '{}',
     true,
     true,
     true
   )
   ON CONFLICT (id) DO NOTHING;
   ```

**验收标准**:
- Migration 幂等可重复执行
- 系统默认 Agent 已 seed，`is_system = true`，`org_id = NULL`
- 现有 Agent 数据不受影响（`is_system` 默认 false）

---

## Task 1: 常量 & 类型定义 ⬜

**文件**:
- `apps/api/src/constants/config.ts`
- `apps/api/src/constants/errorCodes.ts`
- `packages/shared-types/src/agent.ts`

**改动**:

1. `config.ts` — 新增系统默认 Agent ID 常量：
   ```typescript
   /** 系统默认 Agent ID (well-known UUID) */
   export const SYSTEM_DEFAULT_AGENT_ID = '00000000-0000-0000-0000-000000000001'
   ```

2. `errorCodes.ts` — 新增错误码：
   ```typescript
   // Agent 相关（在现有 AGENT_LIMIT_EXCEEDED 后面添加）
   export const AGENT_SYSTEM_READONLY = 'AGENT_SYSTEM_READONLY'
   ```
   HTTP 状态码映射中添加：
   ```typescript
   [AGENT_SYSTEM_READONLY]: 403,
   ```
   错误消息映射中添加：
   ```typescript
   [AGENT_SYSTEM_READONLY]: '系统 Agent 不可修改或删除',
   ```

3. `packages/shared-types/src/agent.ts` — `Agent` 接口新增字段：
   ```typescript
   /** Whether this is a system-level agent */
   isSystem?: boolean;
   ```

**验收标准**:
- 常量和类型定义完整，TypeScript 编译通过

---

## Task 2: Agent Repository 层 ⬜

**文件**: `apps/api/src/repositories/agent.repository.ts`

**改动**:

1. `AgentRow` 接口修改：
   ```typescript
   org_id: string | null  // 原来是 string，改为 nullable
   is_system: boolean     // 新增
   ```

2. 新增 `findSystemDefault()` 方法：
   ```typescript
   export async function findSystemDefault(): Promise<AgentRow | null> {
     const result = await sql`
       SELECT * FROM agents WHERE is_system = true AND deleted_at IS NULL LIMIT 1
     `
     if (result.length === 0) return null
     return result[0] as unknown as AgentRow
   }
   ```

3. `findByIdAndOrg()` — 系统 Agent 对所有 org 可见：
   ```typescript
   // 原查询:
   // WHERE id = ${id} AND org_id = ${orgId} AND deleted_at IS NULL
   // 改为:
   // WHERE id = ${id} AND (org_id = ${orgId} OR is_system = true) AND deleted_at IS NULL
   ```

4. `findByOrg()` — 查询结果包含系统 Agent，排序 `is_system DESC` 让系统 Agent 排第一：
   - 所有分支的 WHERE 条件从 `org_id = ${orgId}` 改为 `(org_id = ${orgId} OR is_system = true)`
   - COUNT 查询同步修改
   - ORDER BY 改为 `is_system DESC, updated_at DESC`

5. `findOtherActiveByOrg()` — 系统 Agent 可作为委派候选：
   ```sql
   WHERE (org_id = ${orgId} OR is_system = true)
     AND id != ${excludeAgentId}
     AND is_active = true
     AND deleted_at IS NULL
   ```

6. `update()` — 加 `is_system` 守卫：
   ```typescript
   // 在获取 agent 后、执行更新前添加：
   if (agent.is_system) {
     return null  // 系统 Agent 不可修改，由 Service 层抛出具体错误
   }
   ```

7. `softDelete()` — 加 `is_system` 守卫：
   ```sql
   -- WHERE 条件追加:
   AND is_system = false
   ```

**验收标准**:
- 系统 Agent 在所有 org 的查询中可见
- 系统 Agent 排在列表第一位
- 系统 Agent 无法被 update/softDelete

---

## Task 3: Agent Service 层 ⬜

**文件**: `apps/api/src/services/agent.service.ts`

**改动**:

1. `rowToAgent()` — 映射 `isSystem` 字段：
   ```typescript
   // 在 return 对象中添加:
   isSystem: row.is_system,
   ```
   同时 `Agent` 接口新增 `isSystem?: boolean`

2. 新增 `getSystemDefaultAgent()` 方法：
   ```typescript
   export async function getSystemDefaultAgent(): Promise<Agent> {
     const row = await agentRepository.findSystemDefault()
     if (!row) {
       throw createError(AGENT_NOT_FOUND, '系统默认 Agent 未配置')
     }
     return rowToAgent(row)
   }
   ```

3. `updateAgent()` — 加 `isSystem` 守卫：
   ```typescript
   // 在 getAgent 之后添加:
   if (existing.isSystem) {
     throw createError(AGENT_SYSTEM_READONLY)
   }
   ```

4. `deleteAgent()` — 加 `isSystem` 守卫：
   ```typescript
   // 在 softDelete 之前添加:
   const agent = await getAgent(orgId, agentId)
   if (agent.isSystem) {
     throw createError(AGENT_SYSTEM_READONLY)
   }
   ```

5. 导入新增的错误码：
   ```typescript
   import { AGENT_SYSTEM_READONLY } from '../constants/errorCodes'
   ```

**验收标准**:
- `getSystemDefaultAgent()` 能正确返回系统 Agent
- 修改/删除系统 Agent 返回 403 + `AGENT_SYSTEM_READONLY`
- `getAgent()` 能跨 org 获取系统 Agent（底层 `findByIdAndOrg` 已处理）

---

## Task 4: 系统能力继承（核心） ⬜

当为任意 Agent 组装 RuntimeInputState 时，自动合并系统级 MCP Servers。

**文件**:
- `apps/api/src/repositories/mcp.repository.ts`
- `apps/api/src/services/mcp.service.ts`
- `apps/api/src/services/chat.service.ts`

**改动**:

### mcp.repository.ts

1. `McpServerRow` 接口新增：
   ```typescript
   is_system: boolean
   org_id: string | null  // 原来是 string
   ```

2. 新增 `findSystemMcpServers()` 方法：
   ```typescript
   export async function findSystemMcpServers(): Promise<McpServerRow[]> {
     const result = await sql`
       SELECT * FROM mcp_servers
       WHERE is_system = true AND is_active = true AND deleted_at IS NULL
       ORDER BY name
     `
     return result as unknown as McpServerRow[]
   }
   ```

3. `findAll()` — WHERE 条件加 `OR is_system = true`：
   ```typescript
   // 原: org_id = ${orgId} AND is_active = true AND deleted_at IS NULL
   // 改: (org_id = ${orgId} OR is_system = true) AND is_active = true AND deleted_at IS NULL
   ```

### mcp.service.ts

1. `McpServer` 接口 `orgId` 改为 `string | null`（可选）

2. 新增 `getSystemMcpServersForRuntime()` 方法：
   ```typescript
   export async function getSystemMcpServersForRuntime(): Promise<Array<{
     id: string
     name: string
     endpoint: string
     transport: string
     is_connected: boolean
     available_tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
   }>> {
     const servers = await mcpRepository.findSystemMcpServers()
     return servers.map((server) => {
       const serverTools: McpTool[] = parseJsonField(server.tools) || []
       return {
         id: server.id,
         name: server.name,
         endpoint: server.endpoint,
         transport: server.transport,
         is_connected: true,
         auth_config: parseJsonField(server.auth_config) || null,
         available_tools: serverTools.map((tool) => ({
           name: tool.name,
           description: tool.description || '',
           parameters: tool.inputSchema || {},
         })),
       }
     })
   }
   ```

### chat.service.ts

在 `handleChatWithRuntime()` 中加载 MCP Servers 的位置（约 line 404-420），合并系统级 MCP Servers：

```typescript
// 加载 Agent 关联的 MCP Servers
try {
  const mcpServers = await mcpService.getMcpServersForRuntime(agent.id)

  // 加载系统级 MCP Servers 并合并（去重）
  const systemMcpServers = await mcpService.getSystemMcpServersForRuntime()
  const agentServerIds = new Set(mcpServers.map(s => s.id))
  const mergedServers = [
    ...mcpServers,
    ...systemMcpServers.filter(s => !agentServerIds.has(s.id)),
  ]

  if (mergedServers.length > 0) {
    runtimeInput.available_mcp_servers = mergedServers
    chatLogger.info('已加载 MCP Servers（含系统级）', {
      agentId: agent.id,
      agentServerCount: mcpServers.length,
      systemServerCount: systemMcpServers.length,
      totalCount: mergedServers.length,
    })
  }
} catch (err) {
  chatLogger.warn('加载 MCP Servers 失败，继续无 MCP 模式', {
    agentId: agent.id,
    error: (err as Error).message,
  })
}
```

同样在 `handleChatDirect()` 中加载 MCP 工具的位置（约 line 543-552），合并系统级 MCP 工具：

```typescript
// 加载 Agent 关联的 MCP 工具
let mcpTools: mcpService.McpToolForLLM[] = []
const mcpToolMap = new Map<string, mcpService.McpToolForLLM>()
try {
  mcpTools = await mcpService.getMcpToolsForAgent(agent.id)

  // 加载系统级 MCP 工具并合并（去重）
  const systemServers = await mcpRepository.findSystemMcpServers()
  for (const server of systemServers) {
    const serverTools = parseJsonField(server.tools) || []
    for (const tool of serverTools) {
      const prefixedName = `mcp_${server.name}__${tool.name}`
      // 去重：Agent 专属工具优先
      if (!mcpTools.some(t => t.function.name === prefixedName)) {
        mcpTools.push({
          type: 'function',
          function: {
            name: prefixedName,
            description: tool.description || '',
            parameters: tool.inputSchema || {},
          },
          _mcpMeta: {
            serverId: server.id,
            serverName: server.name,
            originalToolName: tool.name,
          },
        })
      }
    }
  }

  for (const tool of mcpTools) {
    mcpToolMap.set(tool.function.name, tool)
  }
} catch (err) {
  chatLogger.warn('加载 MCP 工具失败，继续无工具模式', { agentId: agent.id, error: (err as Error).message })
}
```

**验收标准**:
- 系统级 MCP Servers 自动合并到所有 Agent 的 RuntimeInputState
- Agent 专属 MCP 与系统 MCP 按 ID 去重，不重复
- 日志清晰记录合并数量

---

## Task 5: API 路由层 ⬜

**文件**:
- `apps/api/src/routes/v1/agents.ts`
- `apps/api/src/routes/v1/chat.ts`
- `apps/api/src/routes/v1/sessions.ts`

**改动**:

### agents.ts

新增 `GET /agents/system-default` 端点（必须放在 `GET /:id` 之前，避免路由冲突）：

```typescript
/**
 * GET /agents/system-default - 获取系统默认 Agent
 */
router.get(
  '/system-default',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const agent = await agentService.getSystemDefaultAgent()
    res.json({
      success: true,
      data: agent,
    })
  })
)
```

### chat.ts

`startChatSchema` 的 `agentId` 改为 optional，handler 中 fallback：

```typescript
const startChatSchema = z.object({
  agentId: z.string().uuid().optional(),  // 原来是必填
  message: z.string().min(1).max(100000),
})
```

Handler 中：
```typescript
import { SYSTEM_DEFAULT_AGENT_ID } from '../../constants/config'

// 在 handler 中:
const agentId = req.body.agentId || SYSTEM_DEFAULT_AGENT_ID
```

### sessions.ts

`createSessionSchema` 的 `agentId` 改为 optional，handler 中 fallback：

```typescript
const createSessionSchema = z.object({
  agentId: z.string().uuid().optional(),  // 原来是必填
  title: z.string().max(200).optional(),
  metadata: z.record(z.unknown()).optional(),
})
```

Handler 中：
```typescript
import { SYSTEM_DEFAULT_AGENT_ID } from '../../constants/config'

// 在 handler 中:
const input = {
  ...req.body,
  agentId: req.body.agentId || SYSTEM_DEFAULT_AGENT_ID,
}
```

**验收标准**:
- `GET /agents/system-default` 返回系统默认 Agent
- `POST /chat/start` 不传 agentId 时自动使用系统默认 Agent
- `POST /sessions` 不传 agentId 时自动使用系统默认 Agent
- 传入 agentId 时行为不变

---

## Task 6: 前端适配 ⬜

**文件**: `apps/web/app/(dashboard)/chat/new/page.tsx`

**改动**:

1. 移除 `defaultTemplates` 常量和 `usingFallbackAgents` 状态

2. `AgentOption` 接口新增 `isSystem?: boolean`，移除 `isFallback`

3. `loadAgents()` 逻辑简化：
   - API 返回的 Agent 列表已包含系统 Agent（排在第一位）
   - 识别 `isSystem: true` 的 Agent，标记为系统 Agent
   - 如果列表为空（不应该发生，因为系统 Agent 始终存在），显示错误提示

4. Agent 卡片中，`isSystem` 的 Agent 显示"系统"标签：
   ```tsx
   {agent.isSystem && (
     <span className="text-xs px-1.5 py-0.5 rounded bg-primary-500/20 text-primary-400">
       系统
     </span>
   )}
   ```

5. `handleStartChat()` 简化：
   - 不选 Agent 时，优先找 `isSystem` 的 Agent，fallback 到 `agents[0]`
   - 移除 `isFallback` / `usingFallbackAgents` 相关判断
   - 不传 `agentId` 也可以创建会话（后端已支持 fallback）

6. 移除底部的 fallback 警告提示（`usingFallbackAgents` 相关 UI）

**验收标准**:
- Agent 列表中系统 Agent 显示"系统"标签，排在第一位
- 不选 Agent 直接输入消息，能正常创建会话并对话
- 移除所有 fallback template 相关代码

---

## 验证方式

1. 运行 migration，确认系统默认 Agent 已 seed
2. `GET /agents` 返回列表中包含系统默认 Agent（isSystem=true），排在第一位
3. `POST /chat/start` 不传 agentId，自动使用系统默认 Agent
4. `PUT /agents/:systemAgentId` 返回 403
5. 前端 `/chat/new` 不选 Agent 直接发消息，能正常对话
6. 为组织 Agent 配置 MCP 后，系统级 MCP 也自动可用（不重复）
