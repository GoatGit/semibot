# SubAgent 委派链路打通 — 任务拆解

> 关联 PRD: [subagent-delegation-chain.md](../PRDS/subagent-delegation-chain.md)
>
> **状态: ✅ 全部完成（8/8 Tasks）**

## 核心设计决策

- **方案 B**：总控 Agent 自己有 skills/MCP，优先用自己的工具，搞不定时才委派
- **动态发现**：不使用 `agents.sub_agents` 静态绑定，API 层自动查询同组织下其他活跃 Agent 作为候选池
- **独立能力**：每个 Agent 用自己的 skills/MCP，不继承父 Agent 的

## 任务总览

共 8 个任务，按依赖顺序排列。Task 0 是前置修复，必须先完成。API 层（Task 1-3）和 Runtime 层（Task 4-5）可并行开发。

---

## Task 0: 修复 Agent system_prompt 不生效的 bug（前置） ✅ 已完成

**问题**: runtime 中 3 次 LLM 调用（PLAN/REFLECT/RESPOND）全部使用硬编码 prompt，完全忽略了 Agent 配置的 system_prompt（包括追加的 Skill 索引 XML）。用户在前端给 Agent 配的人设在 runtime 模式下不生效。

**文件**:
- `runtime/src/llm/base.py` — `generate_plan()`、`generate_response()`、`generate_response_stream()`、`reflect()` 新增 `agent_system_prompt` 参数
- `runtime/src/orchestrator/nodes.py` — `plan_node`、`reflect_node`、`respond_node` 从 `state.context.agent_config.system_prompt` 读取并传入

**改动**:

1. `base.py` 的 3 个方法新增 `agent_system_prompt: str = ""` 参数，将 Agent 人设作为 system prompt 前缀注入：
   ```
   [Agent system_prompt（人设 + Skill 索引）]
   ---
   [节点任务指令（planning/reflect/response）]
   ```

2. `nodes.py` 的 3 个节点提取 `agent_system_prompt` 并传入：
   ```python
   agent_system_prompt = ""
   runtime_context = state.get("context")
   if runtime_context and runtime_context.agent_config:
       agent_system_prompt = runtime_context.agent_config.system_prompt or ""
   ```

**验收标准**:
- Agent 配置的 system_prompt 在 PLAN/REFLECT/RESPOND 三个节点的 LLM 调用中生效
- Skill 索引 XML（追加在 system_prompt 中）在 runtime 模式下生效
- 不传 system_prompt 时行为不变（使用默认 prompt）
- 现有测试不受影响

---

## Task 1: API 层 — agent.repository 新增 findOtherActiveByOrg ✅ 已完成

**文件**: `apps/api/src/repositories/agent.repository.ts`

**改动**:
- 新增 `findOtherActiveByOrg(orgId: string, excludeAgentId: string, limit: number = 20)` 方法
- 查询同组织下除当前 Agent 外的所有活跃 Agent
- SQL: `WHERE org_id = $1 AND id != $2 AND is_active = true AND deleted_at IS NULL ORDER BY created_at DESC LIMIT $3`
- 加 `limit` 防止组织下 Agent 过多导致 payload 膨胀

**验收标准**:
- 返回同组织下其他活跃 Agent 列表
- 排除当前 Agent 自身
- 已软删除和非活跃的 Agent 不返回
- 结果数量不超过 limit

---

## Task 2: API 层 — agent.service 新增 getCandidateSubAgents ✅ 已完成

**文件**: `apps/api/src/services/agent.service.ts`

**改动**:
- 新增 `getCandidateSubAgents(orgId: string, currentAgentId: string)` 方法
- 调用 `agentRepository.findOtherActiveByOrg` 查询候选池
- 为每个候选 Agent 加载自己的 Skills（`buildSkillIndex` 注入 system_prompt）
- 为每个候选 Agent 加载自己的 MCP Servers（`mcpService.getMcpServersForRuntime(agentId)`）
- 返回 `SubAgentConfigForRuntime[]` 格式（id, name, description, system_prompt, model, temperature, max_tokens, skills, mcp_servers）
- Skills/MCP 加载失败时 warn 日志并继续，不阻断

**依赖**: Task 1

**验收标准**:
- 返回格式符合 Runtime 输入要求
- 每个候选 Agent 的 system_prompt 包含自己的 Skill 索引 XML
- 每个候选 Agent 的 mcp_servers 是自己关联的 MCP
- 单个 Agent 的 Skills/MCP 加载失败不影响其他候选 Agent

---

## Task 3: API 层 — RuntimeInputState 扩展 + chat.service 传递候选池 ✅ 已完成

**文件**:
- `apps/api/src/adapters/runtime.adapter.ts` — RuntimeInputState 接口和 Zod schema 新增 `available_sub_agents` 字段（含 `mcp_servers` 子字段）
- `apps/api/src/services/chat.service.ts` — `handleChatWithRuntime` 中加载并传递候选子 Agent

**改动**:

1. `runtime.adapter.ts`:
   - `RuntimeInputState` 接口新增 `available_sub_agents?` 字段
   - `runtimeInputStateSchema` Zod schema 新增对应验证

2. `chat.service.ts` 在 `handleChatWithRuntime` 中（加载 MCP Servers 之后）:
   ```typescript
   // 加载同组织下其他 Agent 作为委派候选池
   try {
     const candidateSubAgents = await agentService.getCandidateSubAgents(orgId, agent.id)
     if (candidateSubAgents.length > 0) {
       runtimeInput.available_sub_agents = candidateSubAgents
     }
   } catch (err) {
     chatLogger.warn('加载候选 SubAgents 失败，继续无委派模式', { ... })
   }
   ```

**依赖**: Task 2

**验收标准**:
- 组织下只有当前 Agent 时不传递该字段
- 组织下有其他 Agent 时正确传递候选池
- 加载失败时 warn 日志并继续（不阻断主流程）

---

## Task 4: Runtime 层 — 输入模型和上下文扩展 ✅ 已完成

**文件**:
- `runtime/src/server/models.py` — 新增 `SubAgentInput` 模型（含 `mcp_servers` 字段），`RuntimeInputState` 新增 `available_sub_agents` 字段
- `runtime/src/orchestrator/context.py` — 新增 `SubAgentDefinition` 数据类（含 `mcp_servers` 字段），`RuntimeSessionContext` 新增 `available_sub_agents` 字段

**改动**:

1. `models.py`:
   ```python
   class SubAgentInput(BaseModel):
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
       available_sub_agents: list[SubAgentInput] | None = None
   ```

2. `context.py`:
   ```python
   @dataclass
   class SubAgentDefinition:
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
       available_sub_agents: list[SubAgentDefinition] = field(default_factory=list)
   ```

**验收标准**:
- `RuntimeInputState` 接受 `available_sub_agents` 字段（可选）
- `RuntimeSessionContext` 包含 `available_sub_agents` 列表
- 不传该字段时默认为空列表，不影响现有流程

---

## Task 5: Runtime 层 — SubAgentDelegator 实现（核心） ✅ 已完成

**文件**: `runtime/src/agents/delegator.py`（新建）

**实现要点**:
- `SubAgentDelegator` 类，接收 `runtime_context`、`llm_provider`、`skill_registry`、`event_emitter`、`max_depth`
- `delegate(sub_agent_id, task, context)` 方法：
  1. 递归深度检查（`current_depth >= max_depth` 时返回错误）
  2. 验证 `sub_agent_id` 在候选池中
  3. 构建子 Agent 的 `AgentConfig` 和 `RuntimeSessionContext`
  4. 子 Agent 使用自己的 `mcp_servers`（从 `SubAgentDefinition.mcp_servers`）
  5. 子 Agent 继承父 Agent 的 `available_tools`（内置工具如 code_executor）
  6. 子 Agent 的 `available_sub_agents` 设为空（当前版本不允许再委派）
  7. 连接子 Agent 自己的 MCP servers（复用 `_setup_mcp_client`）
  8. 创建 `UnifiedActionExecutor`（传入子 Agent 的 `mcp_client`）和 `create_agent_graph`
  9. `graph.ainvoke()` 执行，带 `SUB_AGENT_EXECUTION_TIMEOUT=120s` 超时
  10. `finally` 块中清理子 Agent 的 MCP 连接（`sub_mcp_client.close_all()`）
  11. 提取最后一条 assistant 消息作为结果返回

**常量提取**:
- `DEFAULT_MAX_DELEGATION_DEPTH = 2` → `runtime/src/constants/config.py`
- `SUB_AGENT_EXECUTION_TIMEOUT = 120` → `runtime/src/constants/config.py`

**依赖**: Task 4

**验收标准**:
- 正常委派：子 Agent 使用自己的 MCP 和 Skills 执行并返回结果
- 深度超限：返回错误信息，不执行
- 子 Agent 不存在：返回错误信息
- 子 Agent 执行超时：返回超时错误，MCP 连接被清理
- 子 Agent 执行异常：捕获并返回错误信息，MCP 连接被清理
- 日志完整：委派开始、完成、失败均有日志

---

## Task 6: Runtime 层 — routes.py 注入 Delegator + Planner prompt 注入子 Agent 清单 ✅ 已完成

**文件**:
- `runtime/src/server/routes.py` — 解析 `available_sub_agents`，创建 `SubAgentDelegator` 并注入 context
- `runtime/src/llm/base.py` — `generate_plan()` 新增 `available_sub_agents` 参数，追加到 planning prompt
- `runtime/src/orchestrator/nodes.py` — `plan_node()` 传递子 Agent 清单给 `generate_plan()`

**改动**:

1. `routes.py` 在 `run_graph()` 中：
   - 解析 `body.available_sub_agents` → `SubAgentDefinition[]`（含 MCP server 定义）
   - 传入 `RuntimeSessionContext`
   - 创建 `SubAgentDelegator` 并注入 `context["sub_agent_delegator"]`

2. `base.py` 的 `generate_plan()`:
   - 新增 `available_sub_agents: list[dict] | None = None` 参数
   - 当有候选 Agent 时，在 planning prompt 中追加候选清单和委派规则
   - 核心规则：**优先用自己的工具，只在工具无法完成且候选 Agent 描述明确匹配时才委派**

3. `nodes.py` 的 `plan_node()`:
   - 从 `runtime_context.available_sub_agents` 提取候选清单（id, name, description）
   - 传递给 `llm_provider.generate_plan(available_sub_agents=...)`

**依赖**: Task 5

**验收标准**:
- 有候选 Agent 时，Planner prompt 包含候选清单和委派规则
- 无候选 Agent 时，Planner prompt 不包含委派相关内容
- `sub_agent_delegator` 正确注入到 context 中
- LLM 能正确输出 `requires_delegation=true` 和 `delegate_to=<id>`
- 简单任务不触发委派（优先 ACT）

---

## Task 7: 集成测试 ✅ 已完成

**文件**: `runtime/tests/agents/test_delegator.py`（新建，18 个测试全部通过）

**测试用例**:
1. **正常委派流程**: 主 Agent 有候选 Agent，LLM 决策委派，子 Agent 用自己的能力执行并返回结果
2. **优先 ACT**: 主 Agent 自己的工具能搞定时，不触发委派
3. **无候选 Agent**: 组织下只有当前 Agent，走正常 ACT 流程
4. **深度限制**: 模拟超过 max_depth 的委派，验证返回错误
5. **子 Agent 不存在**: LLM 输出了不存在的 agent_id，验证错误处理
6. **子 Agent 超时**: 模拟子 Agent 执行超时，验证超时错误和 MCP 连接清理
7. **MCP 连接清理**: 验证子 Agent 执行完毕后 MCP 连接被正确关闭

**依赖**: Task 6

**验收标准**:
- 所有测试用例通过
- Mock LLM provider 和 skill registry
- 测试可独立运行，不依赖外部服务

---

## 依赖关系

```
Task 1 (repository)
  └→ Task 2 (service)
       └→ Task 3 (adapter + chat.service)

Task 4 (runtime models + context)
  └→ Task 5 (delegator 核心实现)
       └→ Task 6 (routes + planner + nodes)
            └→ Task 7 (集成测试)
```

Task 1-3（API 层）和 Task 4-5（Runtime 层）可以并行开发。Task 6 是两条线的汇合点，Task 7 是最终验证。
