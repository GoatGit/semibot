# SubAgent 委派链路打通 — 技术设计

## 1. 背景

ARCHITECTURE.md 设计中 Agent Runtime 支持 SubAgent 编排（Orchestrator → SubAgt1/2/3），AGENT_RUNTIME.md 也定义了完整的 DELEGATE 节点和 SubAgentDelegator 类。

当前实现现状：
- **状态图骨架已就绪**：`delegate_node()` 已实现，`route_after_plan()` 支持路由到 `"delegate"`，`ExecutionPlan` 包含 `requires_delegation` / `delegate_to` 字段
- **断点**：`SubAgentDelegator` 未实现、API→Runtime 未传递候选 Agent 信息、Planner 不知道有���些 Agent 可以委派

## 2. 目标

1. **修复 Agent system_prompt 不生效的 bug**：当前 runtime 的 3 次 LLM 调用（PLAN/REFLECT/RESPOND）全部使用硬编码 prompt，完全忽略了 Agent 配置的 system_prompt（包括追加的 Skill 索引 XML）。需要在每次 LLM 调用中注入 Agent 的 system_prompt 作为基础人设。
2. **打通 SubAgent 委派链路**：总控 Agent 优先使用自己的 tools/skills/MCP 处理任务，当任务超出自身能力范围时，Planner 从同组织下其他 Agent 中动态选择最合适的进行委派。

## 3. 核心设计决策

### 3.1 方案 B：总控 Agent 自己也有能力，不够时才委派

- 总控 Agent 配了自己的 skills/MCP（搜索、代码执行等通用能力）
- Planner 先看自己的工具能不能搞定，搞不定再看有没有更专业的 Agent 可以委派
- 对应 `route_after_plan` 已有的优先级：**ACT > DELEGATE > RESPOND**

### 3.2 动态发现，非静态绑定

- **不使用** `agents.sub_agents TEXT[]` 字段做委派依据
- API 层在每次对话时，自动查询同组织下所有活跃的、非当前 Agent 的其他 Agent 作为候选池
- Planner 根据候选 Agent 的 `name` + `description` 判断是否需要委派以及委派给谁

### 3.3 每个 Agent 独立能力

- 每个 Agent 有自己的 skills、MCP servers、system_prompt
- 子 Agent 执行时使用自己的能力，不继承总控 Agent 的
- 内置工具（code_executor 等）是 Runtime 全局的，所有 Agent 共享

## 4. 整体数据流

```
┌─────────────────────────────────────────────────────────────────────┐
│ API 层 (chat.service.ts)                                            │
│                                                                     │
│  1. 获取当前 Agent 的 skills/MCP（已有逻辑）                          │
│  2. 查询同组织下其他活跃 Agent 作为候选池                              │
│  3. 为每个候选 Agent 加载其 skills（注入 system_prompt）和 MCP         │
│  4. 构建 available_sub_agents 传入 RuntimeInputState                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ POST /api/v1/execute/stream
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Runtime 层 (routes.py)                                              │
│                                                                     │
│  5. 解析 available_sub_agents → SubAgentDefinition[]                │
│  6. 注入 RuntimeSessionContext.available_sub_agents                  │
│  7. 创建 SubAgentDelegator 并注入 context                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Planner (generate_plan)                                             │
│                                                                     │
│  8. planning prompt 中同时注入：                                     │
│     - 自己的 tools（优先使用）                                       │
│     - 可委派的 Agent 清单（自己搞不定时才委派）                       │
│  9. LLM 决策：                                                      │
│     - 能用工具解决 → requires_delegation=false, steps=[...]          │
│     - 需要委派 → requires_delegation=true, delegate_to="agent_id"   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
             ┌─────────────┐      ┌─────────────────┐
             │ ACT (已有)   │      │ DELEGATE (已有)  │
             │ 用自己的工具  │      │ 委派给子 Agent   │
             └──────┬──────┘      └────────┬────────┘
                    │                      │
                    └──────────┬───────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SubAgentDelegator (新增)                                            │
│                                                                     │
│  10. 验证 agent_id 在候选池中                                        │
│  11. 构建子 Agent 的 RuntimeSessionContext（用子 Agent 自己的能力）    │
│  12. 连接子 Agent 自己的 MCP servers                                 │
│  13. create_agent_graph() + graph.ainvoke() 执行子 Agent             │
│  14. 清理子 Agent MCP 连接，收集结果返回给 delegate_node              │
└─────────────────────────────────────────────────────────────────────┘
```

## 5. 详细设计

### 5.0 修复 Agent system_prompt 注入（前置修复）

#### 5.0.1 问题现状

Agent 配置的 `system_prompt` 正确传入了 `RuntimeSessionContext.agent_config.system_prompt`，但 runtime 中 3 次 LLM 调用全部忽略了它：

| 节点 | LLM 方法 | 当前 system prompt | Agent system_prompt |
|------|---------|-------------------|---------------------|
| PLAN | `generate_plan()` | 硬编码 planning_prompt | 被忽略 |
| REFLECT | `reflect()` | 硬编码 reflect_prompt | 被忽略 |
| RESPOND | `generate_response()` | 硬编码 response_prompt | 被忽略 |

这意味着用户在前端给 Agent 配的人设、Skill 索引 XML 在 runtime 模式下完全不生效。

#### 5.0.2 修复方案

在每次 LLM 调用中，将 Agent 的 `system_prompt` 作为基础人设注入，再追加各节点的任务指令。格式：

```
[Agent system_prompt（人设 + Skill 索引）]

---

[节点任务指令（planning/reflect/response）]
```

#### 5.0.3 具体改动

修改 `llm/base.py` 的 3 个方法，新增 `agent_system_prompt` 参数：

1. `generate_plan()`:
```python
async def generate_plan(self, messages, memory="", available_tools=None,
                        available_sub_agents=None, agent_system_prompt=""):
    # ... 现有 planning_prompt 构建 ...

    # 注入 Agent 人设
    if agent_system_prompt:
        planning_prompt = f"{agent_system_prompt}\n\n---\n\n{planning_prompt}"

    system_message = {"role": "system", "content": planning_prompt}
    all_messages = [system_message] + messages
```

2. `generate_response()` / `generate_response_stream()`:
```python
async def generate_response(self, messages, results=None, reflection=None,
                            agent_system_prompt=""):
    # ... 现有 context 构建 ...

    base_prompt = agent_system_prompt or "You are a helpful assistant."
    system_message = {
        "role": "system",
        "content": f"""{base_prompt}

---

Generate a helpful response to the user based on the execution results.

{context}

Be concise but informative. If there were errors, explain what happened and suggest alternatives.
""",
    }
```

3. `reflect()`:
```python
async def reflect(self, messages, plan=None, results=None, agent_system_prompt=""):
    base_prompt = agent_system_prompt or ""
    prompt = f"""{base_prompt}

---

Reflect on this task execution. Analyze what was accomplished...
"""
```

对应修改 `orchestrator/nodes.py` 的 3 个节点，从 `state.context.agent_config.system_prompt` 读取并传入：

```python
# 在 plan_node / reflect_node / respond_node 中
agent_system_prompt = ""
runtime_context = state.get("context")
if runtime_context and runtime_context.agent_config:
    agent_system_prompt = runtime_context.agent_config.system_prompt or ""

# 传入各 LLM 方法
await llm_provider.generate_plan(..., agent_system_prompt=agent_system_prompt)
await llm_provider.reflect(..., agent_system_prompt=agent_system_prompt)
await llm_provider.generate_response(..., agent_system_prompt=agent_system_prompt)
```

### 5.1 API 层改动

#### 5.1.1 agent.repository.ts — 新增 findOtherActiveByOrg

查询同组织下除当前 Agent 外的所有活跃 Agent，作为委派候选池。

```typescript
export async function findOtherActiveByOrg(
  orgId: string,
  excludeAgentId: string,
  limit: number = 20
): Promise<AgentRow[]> {
  const rows = await sql`
    SELECT * FROM agents
    WHERE org_id = ${orgId}
      AND id != ${excludeAgentId}
      AND is_active = true
      AND deleted_at IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}
  `
  return rows as AgentRow[]
}
```

注意：加 `limit` 防止组织下 Agent 过多导致 payload 膨胀。候选池上限 20 个足够 Planner 选择。

#### 5.1.2 agent.service.ts — 新增 getCandidateSubAgents

为每个候选 Agent 加载其独立的 skills 和 MCP servers。

```typescript
export async function getCandidateSubAgents(
  orgId: string,
  currentAgentId: string
): Promise<SubAgentConfigForRuntime[]> {
  const candidates = await agentRepository.findOtherActiveByOrg(orgId, currentAgentId)

  const results: SubAgentConfigForRuntime[] = []

  for (const row of candidates) {
    const a = rowToAgent(row)

    // 加载候选 Agent 自己的 Skill 索引（注入 system_prompt）
    let systemPrompt = a.systemPrompt || `你是 ${a.name}，一个有帮助的 AI 助手。`
    if (a.skills && a.skills.length > 0) {
      try {
        const skillPairs = await loadSkillPairs(a.skills)
        if (skillPairs.length > 0) {
          const skillIndexXml = await buildSkillIndex(skillPairs)
          if (skillIndexXml) {
            systemPrompt += '\n\n' + skillIndexXml
          }
        }
      } catch (err) {
        chatLogger.warn('加载候选 Agent Skills 失败', {
          agentId: a.id, error: (err as Error).message,
        })
      }
    }

    // 加载候选 Agent 自己的 MCP Servers
    let mcpServers: McpServerForRuntime[] = []
    try {
      mcpServers = await mcpService.getMcpServersForRuntime(a.id)
    } catch (err) {
      chatLogger.warn('加载候选 Agent MCP Servers 失败', {
        agentId: a.id, error: (err as Error).message,
      })
    }

    results.push({
      id: a.id,
      name: a.name,
      description: a.description || '',
      system_prompt: systemPrompt,
      model: a.config?.model,
      temperature: a.config?.temperature ?? 0.7,
      max_tokens: a.config?.maxTokens ?? 4096,
      skills: a.skills || [],
      mcp_servers: mcpServers,
    })
  }

  return results
}
```

#### 5.1.3 chat.service.ts — handleChatWithRuntime 加载候选池

在构建 `runtimeInput` 时（加载 MCP Servers 之后），加载候选子 Agent：

```typescript
// 加载同组织下其他 Agent 作为委派候选池
try {
  const candidateSubAgents = await agentService.getCandidateSubAgents(orgId, agent.id)
  if (candidateSubAgents.length > 0) {
    runtimeInput.available_sub_agents = candidateSubAgents
    chatLogger.info('已加载候选 SubAgents', {
      agentId: agent.id,
      candidateCount: candidateSubAgents.length,
    })
  }
} catch (err) {
  chatLogger.warn('加载候选 SubAgents 失败，继续无委派模式', {
    agentId: agent.id,
    error: (err as Error).message,
  })
}
```

#### 5.1.4 runtime.adapter.ts — RuntimeInputState 扩展

```typescript
// 新增字段
available_sub_agents?: Array<{
  id: string
  name: string
  description: string
  system_prompt: string
  model?: string
  temperature?: number
  max_tokens?: number
  skills?: string[]
  mcp_servers?: Array<{
    id: string
    name: string
    endpoint: string
    transport: string
    is_connected: boolean
    auth_config?: Record<string, unknown> | null
    available_tools: Array<{
      name: string
      description: string
      parameters: Record<string, unknown>
    }>
  }>
}>
```

同步更新 `runtimeInputStateSchema` 的 Zod 验证。

### 5.2 Runtime 层改动

#### 5.2.1 server/models.py — 新增 SubAgentInput

```python
class SubAgentInput(BaseModel):
    """SubAgent configuration from the API layer."""
    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    skills: list[str] = Field(default_factory=list)
    mcp_servers: list[McpServerInput] = Field(default_factory=list)

class RuntimeInputState(BaseModel):
    # ... 现有字段 ...
    available_sub_agents: list[SubAgentInput] | None = None  # 新增
```

#### 5.2.2 context.py — 新增 SubAgentDefinition

```python
@dataclass
class SubAgentDefinition:
    """SubAgent definition for delegation."""
    id: str
    name: str
    description: str = ""
    system_prompt: str = ""
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 4096
    skills: list[str] = field(default_factory=list)
    mcp_servers: list[McpServerDefinition] = field(default_factory=list)

@dataclass
class RuntimeSessionContext:
    # ... 现有字段 ...
    available_sub_agents: list[SubAgentDefinition] = field(default_factory=list)  # 新增
```

#### 5.2.3 server/routes.py — 构建 SubAgent 上下文并注入 Delegator

在 `execute_stream` 的 `run_graph()` 中：

```python
# Build SubAgent definitions from input
sub_agents: list[SubAgentDefinition] = []
if body.available_sub_agents:
    for sa in body.available_sub_agents:
        sa_mcp_servers: list[McpServerDefinition] = []
        if sa.mcp_servers:
            for srv in sa.mcp_servers:
                sa_mcp_servers.append(McpServerDefinition(
                    id=srv.id,
                    name=srv.name,
                    endpoint=srv.endpoint,
                    transport=srv.transport,
                    is_connected=False,
                    available_tools=[
                        {"name": t.name, "description": t.description, "parameters": t.parameters}
                        for t in srv.available_tools
                    ],
                ))

        sub_agents.append(SubAgentDefinition(
            id=sa.id,
            name=sa.name,
            description=sa.description,
            system_prompt=sa.system_prompt,
            model=sa.model,
            temperature=sa.temperature,
            max_tokens=sa.max_tokens,
            skills=sa.skills,
            mcp_servers=sa_mcp_servers,
        ))

runtime_context = RuntimeSessionContext(
    # ... 现有字段 ...
    available_sub_agents=sub_agents,  # 新增
)

# 创建 SubAgentDelegator 并注入 context
if sub_agents:
    from src.agents.delegator import SubAgentDelegator
    delegator = SubAgentDelegator(
        runtime_context=runtime_context,
        llm_provider=llm_provider,
        skill_registry=skill_registry,
        event_emitter=emitter,
        max_depth=2,
    )
    context["sub_agent_delegator"] = delegator
```

#### 5.2.4 agents/delegator.py — SubAgentDelegator 实现（核心新增文件）

```python
"""SubAgent Delegator implementation.

Handles delegation of tasks to SubAgents by creating isolated execution
graphs and running them within the parent agent's context.
"""

import asyncio
from typing import Any

from src.orchestrator.context import (
    AgentConfig,
    RuntimeSessionContext,
    SubAgentDefinition,
)
from src.orchestrator.graph import create_agent_graph
from src.orchestrator.state import create_initial_state
from src.utils.logging import get_logger

logger = get_logger(__name__)

# 最大递归委派深度
DEFAULT_MAX_DELEGATION_DEPTH = 2
# 子 Agent 执行超时（秒）
SUB_AGENT_EXECUTION_TIMEOUT = 120


class SubAgentDelegator:
    """
    SubAgent 委派器。

    负责：
    1. 验证目标子 Agent 存在且可用
    2. 构建子 Agent 的独立执行上下文（使用子 Agent 自己的 skills/MCP）
    3. 连接子 Agent 的 MCP servers
    4. 创建并执行子 Agent 的 LangGraph
    5. 清理 MCP 连接，收集结果返回给父 Agent
    """

    def __init__(
        self,
        runtime_context: RuntimeSessionContext,
        llm_provider: Any = None,
        skill_registry: Any = None,
        event_emitter: Any = None,
        max_depth: int = DEFAULT_MAX_DELEGATION_DEPTH,
        current_depth: int = 0,
    ):
        self.runtime_context = runtime_context
        self.llm_provider = llm_provider
        self.skill_registry = skill_registry
        self.event_emitter = event_emitter
        self.max_depth = max_depth
        self.current_depth = current_depth

        # 构建 sub_agent_id → SubAgentDefinition 的索引
        self._sub_agent_map: dict[str, SubAgentDefinition] = {
            sa.id: sa for sa in runtime_context.available_sub_agents
        }

    async def delegate(
        self,
        sub_agent_id: str,
        task: str,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        委派任务给子 Agent。

        Args:
            sub_agent_id: 目标子 Agent ID
            task: 委派的任务描述
            context: 额外上下文（memory、parent_session_id 等）

        Returns:
            {"result": ..., "agent_id": ..., "error": ...}
        """
        context = context or {}

        # 1. 深度检查
        if self.current_depth >= self.max_depth:
            logger.warning(
                "Delegation depth limit reached",
                extra={
                    "current_depth": self.current_depth,
                    "max_depth": self.max_depth,
                    "sub_agent_id": sub_agent_id,
                },
            )
            return {
                "error": f"Delegation depth limit reached ({self.max_depth})",
                "agent_id": sub_agent_id,
            }

        # 2. 验证子 Agent 存在
        sub_agent_def = self._sub_agent_map.get(sub_agent_id)
        if not sub_agent_def:
            logger.error(
                "SubAgent not found in candidate pool",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "available": list(self._sub_agent_map.keys()),
                },
            )
            return {
                "error": f"SubAgent '{sub_agent_id}' not found",
                "agent_id": sub_agent_id,
            }

        logger.info(
            "Delegating to SubAgent",
            extra={
                "sub_agent_id": sub_agent_id,
                "sub_agent_name": sub_agent_def.name,
                "depth": self.current_depth + 1,
                "task_preview": task[:200],
            },
        )

        sub_mcp_client = None
        try:
            # 3. 构建子 Agent 的 AgentConfig
            sub_agent_config = AgentConfig(
                id=sub_agent_def.id,
                name=sub_agent_def.name,
                description=sub_agent_def.description,
                system_prompt=sub_agent_def.system_prompt,
                model=sub_agent_def.model,
                temperature=sub_agent_def.temperature,
                max_tokens=sub_agent_def.max_tokens,
            )

            # 4. 构建子 Agent 的 RuntimeSessionContext
            #    - 使用子 Agent 自己的 MCP servers
            #    - 继承父 Agent 的 builtin tools（code_executor 等内置工具）
            #    - Skills 已通过 system_prompt 注入（API 层处理）
            #    - 不传 available_sub_agents（当前版本不允许再委派）
            sub_runtime_context = RuntimeSessionContext(
                org_id=self.runtime_context.org_id,
                user_id=self.runtime_context.user_id,
                agent_id=sub_agent_def.id,
                session_id=self.runtime_context.session_id,
                agent_config=sub_agent_config,
                available_tools=self.runtime_context.available_tools,  # 内置工具共享
                available_mcp_servers=sub_agent_def.mcp_servers,       # 子 Agent 自己的 MCP
                available_sub_agents=[],  # 当前版本不允许再委派
            )

            # 5. 构建子 Agent 的 graph context
            sub_context: dict[str, Any] = {}

            if self.event_emitter:
                sub_context["event_emitter"] = self.event_emitter
            if self.llm_provider:
                sub_context["llm_provider"] = self.llm_provider
            if self.skill_registry:
                sub_context["skill_registry"] = self.skill_registry

            # 6. 连接子 Agent 自己的 MCP servers
            if sub_agent_def.mcp_servers:
                from src.server.routes import _setup_mcp_client
                from src.server.models import McpServerInput as _McpSrvInput
                mcp_inputs = [
                    _McpSrvInput(
                        id=srv.id, name=srv.name, endpoint=srv.endpoint,
                        transport=srv.transport, is_connected=False,
                        available_tools=[],
                    )
                    for srv in sub_agent_def.mcp_servers
                ]
                sub_mcp_client = await _setup_mcp_client(mcp_inputs)
                if sub_mcp_client:
                    for srv_def in sub_runtime_context.available_mcp_servers:
                        srv_def.is_connected = sub_mcp_client.is_connected(srv_def.id)

            # 7. 构建子 Agent 的 UnifiedActionExecutor
            from src.orchestrator.unified_executor import UnifiedActionExecutor

            sub_executor = UnifiedActionExecutor(
                runtime_context=sub_runtime_context,
                skill_registry=self.skill_registry,
                mcp_client=sub_mcp_client,
            )
            sub_context["unified_executor"] = sub_executor

            # 8. 创建子 Agent 的执行图
            sub_graph = create_agent_graph(
                context=sub_context,
                runtime_context=sub_runtime_context,
            )

            # 9. 构建初始状态
            initial_state = create_initial_state(
                session_id=self.runtime_context.session_id,
                agent_id=sub_agent_def.id,
                org_id=self.runtime_context.org_id,
                user_message=task,
                context=sub_runtime_context,
                metadata={
                    "parent_agent_id": self.runtime_context.agent_id,
                    "delegation_depth": self.current_depth + 1,
                },
            )

            # 10. 执行子 Agent（带超时）
            result = await asyncio.wait_for(
                sub_graph.ainvoke(initial_state),
                timeout=SUB_AGENT_EXECUTION_TIMEOUT,
            )

            # 11. 提取结果
            messages = result.get("messages", [])
            final_response = ""
            if messages:
                last_msg = messages[-1]
                if isinstance(last_msg, dict):
                    final_response = last_msg.get("content", "")
                else:
                    final_response = getattr(last_msg, "content", "")

            logger.info(
                "SubAgent delegation completed",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "response_length": len(final_response),
                },
            )

            return {
                "result": final_response,
                "agent_id": sub_agent_id,
                "agent_name": sub_agent_def.name,
            }

        except asyncio.TimeoutError:
            logger.error(
                "SubAgent execution timed out",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "timeout": SUB_AGENT_EXECUTION_TIMEOUT,
                },
            )
            return {
                "error": f"SubAgent execution timed out ({SUB_AGENT_EXECUTION_TIMEOUT}s)",
                "agent_id": sub_agent_id,
            }
        except Exception as e:
            logger.error(
                "SubAgent delegation failed",
                extra={
                    "sub_agent_id": sub_agent_id,
                    "error": str(e),
                },
            )
            return {
                "error": str(e),
                "agent_id": sub_agent_id,
            }
        finally:
            # 清理子 Agent 的 MCP 连接
            if sub_mcp_client:
                try:
                    await sub_mcp_client.close_all()
                except Exception as e:
                    logger.warning(f"Failed to close sub-agent MCP connections: {e}")
```

#### 5.2.5 Planner prompt 注入子 Agent 清单

在 `llm/base.py` 的 `generate_plan()` 中，当 `available_sub_agents` 存在时，追加到 planning prompt。关键是让 LLM 理解"优先用自己的工具，搞不定才委派"：

```python
async def generate_plan(
    self,
    messages,
    memory="",
    available_tools=None,
    available_sub_agents=None,  # 新增
):
    # ... 现有 tools_text 构建 ...

    # 构建子 Agent 清单
    sub_agents_text = ""
    if available_sub_agents:
        sa_lines = []
        for sa in available_sub_agents:
            sa_lines.append(f"- {sa['name']} (id: {sa['id']}): {sa['description']}")
        sub_agents_text = "\n".join(sa_lines)

    # 追加到 planning prompt
    if sub_agents_text:
        planning_prompt += f"""
Available specialized agents for delegation:
{sub_agents_text}

DELEGATION RULES:
- ALWAYS prefer using your own tools first. Only delegate when:
  1. The task clearly requires expertise that a specialized agent has but you don't
  2. Your available tools cannot accomplish the task
  3. A specialized agent's description explicitly matches the task domain
- Set requires_delegation=true and delegate_to=<agent_id> ONLY when delegating
- You can only delegate to ONE agent per plan
- Do NOT delegate simple questions or tasks your tools can handle
"""
```

对应修改 `plan_node` 中调用 `generate_plan` 时传入子 Agent 清单：

```python
# plan_node 中
sub_agents_for_planner = []
if runtime_context and runtime_context.available_sub_agents:
    sub_agents_for_planner = [
        {"id": sa.id, "name": sa.name, "description": sa.description}
        for sa in runtime_context.available_sub_agents
    ]

plan_response = await llm_provider.generate_plan(
    messages=messages,
    memory=memory_context,
    available_tools=available_skills,
    available_sub_agents=sub_agents_for_planner,  # 新增
)
```

### 5.3 SSE 事件设计

子 Agent 执行时复用父 Agent 的 `event_emitter`，事件自然透传。前端通过 `skill_call_start/complete` 事件中的 `subagent:` 前缀识别委派事件（`delegate_node` 已有此逻辑）。

新增 SSE 事件类型（可选，用于更精细的前端展示）：

```python
async def emit_delegation_start(self, sub_agent_id, sub_agent_name, task):
    await self._emit("delegation_start", {
        "sub_agent_id": sub_agent_id,
        "sub_agent_name": sub_agent_name,
        "task": task,
    })

async def emit_delegation_complete(self, sub_agent_id, sub_agent_name, success, result=None, error=None):
    await self._emit("delegation_complete", {
        "sub_agent_id": sub_agent_id,
        "sub_agent_name": sub_agent_name,
        "success": success,
        "result_preview": str(result)[:500] if result else None,
        "error": error,
    })
```

### 5.4 安全与限制

| 维度 | 策略 |
|------|------|
| 递归深度 | `max_depth=2`，超过直接返回错误 |
| 多租户隔离 | 候选池查询带 `org_id` 过滤，天然隔离 |
| 候选池大小 | `findOtherActiveByOrg` 限制 `limit=20`，防止 payload 膨胀 |
| 执行超时 | 子 Agent 单次执行 `SUB_AGENT_EXECUTION_TIMEOUT=120s` |
| 子 Agent 再委派 | 当前版本不允许（`available_sub_agents=[]`），后续可按深度放开 |
| MCP 连接清理 | `finally` 块中 `close_all()`，确保不泄漏 |

## 6. 不改动的部分

以下已有代码无需修改：
- `delegate_node()` — 已正确调用 `delegator.delegate()`
- `route_after_plan()` — 已支持路由到 `"delegate"`，优先级 ACT > DELEGATE > RESPOND
- `ExecutionPlan` — 已有 `requires_delegation` / `delegate_to` 字段
- `create_agent_graph()` — 已注册 delegate 节点和边
- Agent CRUD API — 无需改动，`agents.sub_agents` 字段保留但不作为委派依据
