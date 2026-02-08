# Runtime 统一执行链架构设计文档

## 目录

- [概述](#概述)
- [架构目标](#架构目标)
- [系统架构](#系统架构)
- [核心组件](#核心组件)
- [数据流](#数据流)
- [设计决策](#设计决策)
- [扩展性](#扩展性)
- [安全性](#安全性)
- [性能优化](#性能优化)

---

## 概述

Runtime 统一执行链是一个为 AI Agent 提供统一能力管理和执行的系统。它解决了以下核心问题：

1. **能力来源不统一**: Skills、Tools、MCP 工具分散管理
2. **权限不一致**: Planner 和 Executor 看到的能力不同
3. **缺少审计**: 无法追踪 action 执行历史
4. **缺少控制**: 高风险操作无审批机制

### 核心价值

- **统一管理**: 所有能力通过 CapabilityGraph 统一管理
- **权限一致**: Planner 和 Executor 使用同一个能力图
- **完整审计**: 记录所有 action 执行事件
- **安全控制**: 高风险操作需要审批

---

## 架构目标

### 功能目标

1. **统一能力管理**: 统一管理 Skills、Tools、MCP 工具
2. **动态能力图**: 根据 agent 配置动态构建能力图
3. **统一执行入口**: 提供单一执行器处理所有类型的 actions
4. **完整审计追踪**: 记录所有关键事件
5. **审批机制**: 高风险操作需要人工审批

### 非功能目标

1. **高性能**: 批量写入、异步处理
2. **可扩展**: 支持新的能力类型和存储后端
3. **可观测**: 完整的日志和审计
4. **多租户**: 组织和用户级别隔离
5. **向后兼容**: 不破坏现有代码

---

## 系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                         API Layer                            │
│  (构建 RuntimeSessionContext, 调用 Orchestrator)             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Orchestrator                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Plan Node   │→ │   Act Node   │→ │ Observe Node │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│         │                  │                                 │
│         ▼                  ▼                                 │
│  ┌──────────────┐  ┌──────────────────────────────┐        │
│  │CapabilityGraph│  │ UnifiedActionExecutor       │        │
│  └──────────────┘  └──────────────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼             ▼             ▼
        ┌──────────────┐ ┌─────────┐ ┌──────────┐
        │SkillRegistry │ │  Tools  │ │McpClient │
        └──────────────┘ ���─────────┘ └──────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   AuditLogger    │
                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  AuditStorage    │
                    │ (Memory/File/DB) │
                    └──────────────────┘
```

### 分层架构

#### 1. API 层
- 接收用户请求
- 从数据库加载 agent 配置和绑定的 skills
- 查询组织可用的 MCP servers
- 构建 RuntimeSessionContext
- 调用 Orchestrator

#### 2. Orchestrator 层
- 管理 agent 工作流（Plan → Act → Observe → Reflect）
- 使用 CapabilityGraph 管理能力
- 使用 UnifiedActionExecutor 执行 actions
- 记录审计日志

#### 3. 执行层
- SkillRegistry: 管理和执行 skills
- Tools: 内置工具（LLM call、搜索等）
- McpClient: 与 MCP 服务器通信

#### 4. 审计层
- AuditLogger: 记录审计事件
- AuditStorage: 存储审计数据

---

## 核心组件

### 1. RuntimeSessionContext

**职责**: 会话级运行时上下文

**核心字段**:
```python
@dataclass
class RuntimeSessionContext:
    org_id: str                    # 组织 ID（多租户隔离）
    user_id: str                   # 用户 ID
    agent_id: str                  # Agent ID
    session_id: str                # 会话 ID（审计追踪）
    agent_config: AgentConfig      # Agent 配置
    available_skills: list[SkillDefinition]
    available_tools: list[ToolDefinition]
    available_mcp_servers: list[McpServerDefinition]
    runtime_policy: RuntimePolicy  # 运行时策略
```

**设计要点**:
- 包含所有执行所需的上下文信息
- 不可变（创建后不修改）
- 通过 AgentState 传递给所有节点

### 2. CapabilityGraph

**职责**: 动态构建和管理能力图

**核心方法**:
```python
class CapabilityGraph:
    def build() -> None
    def get_schemas_for_planner() -> list[dict]
    def validate_action(action_name: str) -> bool
    def get_capability(name: str) -> Capability | None
```

**设计要点**:
- 从 RuntimeSessionContext 动态构建
- 只包含已连接的 MCP 服务器
- Planner 和 Executor 使用同一个图
- 支持按类型查询能力

**能力类型**:
```python
class Capability(ABC):
    capability_type: str
    name: str
    description: str

class SkillCapability(Capability):
    skill_definition: SkillDefinition

class ToolCapability(Capability):
    tool_definition: ToolDefinition

class McpCapability(Capability):
    mcp_server_id: str
    mcp_server_name: str
    tool_name: str
```

### 3. UnifiedActionExecutor

**职责**: 统一执行所有类型的 actions

**执行流程**:
```
1. 验证 action 是否在能力图内
2. 构建执行元数据
3. 检查是否需要审批
   ├─ 是 → 调用审批钩子
   │       ├─ 通过 → 继续执行
   │       └─ 拒绝 → 返回错误
   └─ 否 → 继续执行
4. 路由到正确的执行器
   ├─ Skill → SkillRegistry.execute()
   ├─ Tool → 内置工具执行
   └─ MCP → McpClient.call_tool()
5. 记录审计日志
6. 返回结果（包含元数据）
```

**设计要点**:
- 单一执行入口
- 自动验证和路由
- 可选的审批机制
- 完整的元数据追踪
- 可选的审计日志

### 4. AuditLogger

**职责**: 记录所有审计事件

**事件类型**:
```python
class AuditEventType(str, Enum):
    ACTION_STARTED = "action_started"
    ACTION_COMPLETED = "action_completed"
    ACTION_FAILED = "action_failed"
    ACTION_REJECTED = "action_rejected"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_GRANTED = "approval_granted"
    APPROVAL_DENIED = "approval_denied"
```

**设计要点**:
- 批量写入优化（减少 I/O）
- 定时刷新机制（防止数据丢失）
- 异步处理（不阻塞主流程）
- 抽象存储接口（支持多种后端）

---

## 数据流

### 1. 完整执行流程

```
┌─────────┐
│ API 层  │
└────┬────┘
     │ 1. 构建 RuntimeSessionContext
     ▼
┌─────────────────┐
│ create_agent_   │
│ graph()         │
└────┬────────────┘
     │ 2. 注入 context 到 AgentState
     ▼
┌─────────────────┐
│ plan_node       │
└────┬────────────┘
     │ 3. 构建 CapabilityGraph
     │ 4. 获取 schemas
     │ 5. 调用 PlannerAgent
     ▼
┌─────────────────┐
│ act_node        │
└────┬────────────┘
     │ 6. 创建 UnifiedActionExecutor
     │ 7. 验证 actions
     │ 8. 执行 actions
     ▼
┌─────────────────┐
│ UnifiedAction   │
│ Executor        │
└────┬────────────┘
     │ 9. 验证能力
     │ 10. 检查审批
     │ 11. 路由执行
     │ 12. 记录审计
     ▼
┌─────────────────┐
│ SkillRegistry / │
│ Tools / MCP     │
└────┬────────────┘
     │ 13. 实际执行
     ▼
┌─────────────────┐
│ AuditLogger     │
└────┬────────────┘
     │ 14. 批量写入
     ▼
┌─────────────────┐
│ AuditStorage    │
└─────────────────┘
```

### 2. 能力图构建流程

```
RuntimeSessionContext
    │
    ├─ available_skills
    │   └─> SkillCapability[]
    │
    ├─ available_tools
    │   └─> ToolCapability[]
    │
    └─ available_mcp_servers
        └─> (filter connected)
            └─> McpCapability[]
                    │
                    └─> CapabilityGraph
```

### 3. 审计日志流程

```
Action 执行
    │
    ├─ log_action_started()
    │   └─> 添加到缓冲区
    │
    ├─ 执行 action
    │
    ├─ log_action_completed() / log_action_failed()
    │   └─> 添加到缓冲区
    │
    └─> 缓冲区满 / 定时器触发
        └─> 批量写入到存储
```

---

## 设计决策

### 1. 为什么使用 RuntimeSessionContext？

**问题**: 能力来源分散，planner 和 executor 不一致

**方案对比**:

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 全局配置 | 简单 | 无法支持多租户、会话隔离 | ❌ |
| 每次传参 | 灵活 | 参数过多、容易遗漏 | ❌ |
| Context 对象 | 统一、完整、可追踪 | 需要额外的数据结构 | ✅ |

**决策**: 使用 RuntimeSessionContext 作为会话级上下文容器

**理由**:
- 包含所有执行所需的信息
- 支持多租户和会话隔离
- 便于审计追踪
- 通过 AgentState 传递，所有节点都能访问

### 2. 为什么使用 CapabilityGraph？

**问题**: Planner 和 Executor 看到的能力不一致

**方案对比**:

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 分别管理 | 简单 | 不一致、难以维护 | ❌ |
| 共享列表 | 一致 | 无法验证、无法查询 | ❌ |
| 能力图 | 一致、可验证、可查询 | 需要额外的抽象 | ✅ |

**决策**: 使用 CapabilityGraph 统一管理能力

**理由**:
- Planner 和 Executor 使用同一个图
- 支持能力验证
- 支持按类型查询
- 只包含已连接的 MCP 服务器

### 3. 为什么使用 UnifiedActionExecutor？

**问题**: 执行逻辑分散，难以添加统一的审计和审批

**方案对比**:

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 分散执行 | 简单 | 无法统一审计、审批 | ❌ |
| 装饰器 | 灵活 | 难以维护、容易遗漏 | ❌ |
| 统一执行器 | 单一入口、易于扩展 | 需要路由逻辑 | ✅ |

**决策**: 使用 UnifiedActionExecutor 作为统一执行入口

**理由**:
- 单一执行入口
- 统一的验证、审批、审计
- 易于添加新功能
- 完整的元数据追踪

### 4. 为什么使用批量写入？

**问题**: 每个事件都写入会影响性能

**方案对比**:

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 同步写入 | 简单、实时 | 性能差、阻塞主流程 | ❌ |
| 异步写入 | 不阻塞 | 可能丢失数据 | ❌ |
| 批量写入 | 高性能、可靠 | 稍微复杂 | ✅ |

**决策**: 使用批量写入 + 定时刷新

**理由**:
- 减少 I/O 操作
- 不阻塞主流程
- 定时刷新防止数据丢失
- 停止时强制刷新

### 5. 为什么使用抽象存储接口？

**问题**: 不同环境需要不同的存储后端

**方案对比**:

| 方案 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| 硬编码存储 | 简单 | 无法切换后端 | ❌ |
| 配置切换 | 灵活 | 难以扩展 | ❌ |
| 抽象接口 | 易于扩展、可测试 | 需要额外的抽象 | ✅ |

**决策**: 使用 AuditStorage 抽象基类

**理由**:
- 支持多种存储后端（内存、文件、数据库）
- 易于测试（使用内存存储）
- 易于扩展（实现新的存储类）

---

## 扩展性

### 1. 添加新的能力类型

```python
# 1. 定义新的 Capability 子类
class CustomCapability(Capability):
    capability_type = "custom"

    def to_schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            # 自定义字段
        }

# 2. 在 CapabilityGraph.build() 中添加构建逻辑
def build(self) -> None:
    # 现有逻辑...

    # 添加自定义能力
    for custom_def in self.context.available_custom:
        capability = CustomCapability(...)
        self.capabilities[custom_def.name] = capability

# 3. 在 UnifiedActionExecutor 中添加执行逻辑
async def execute(self, action: PlanStep) -> ToolCallResult:
    # 现有逻辑...

    if capability.capability_type == "custom":
        result = await self._execute_custom(...)
```

### 2. 添加新的存储后端

```python
# 实现 AuditStorage 接口
class PostgresAuditStorage(AuditStorage):
    def __init__(self, connection_string: str):
        self.conn = psycopg2.connect(connection_string)

    async def store(self, event: AuditEvent) -> None:
        # 实现存储逻辑
        pass

    async def store_batch(self, events: list[AuditEvent]) -> None:
        # 实现批量存储逻辑
        pass

    async def query(self, query: AuditQuery) -> list[AuditEvent]:
        # 实现查询逻辑
        pass

# 使用新的存储
storage = PostgresAuditStorage("postgresql://...")
audit_logger = AuditLogger(storage=storage)
```

### 3. 添加新的审计事件类型

```python
# 1. 在 AuditEventType 中添加新类型
class AuditEventType(str, Enum):
    # 现有类型...
    CUSTOM_EVENT = "custom_event"

# 2. 在 AuditLogger 中添加记录方法
async def log_custom_event(
    self,
    context: RuntimeSessionContext,
    # 自定义参数...
) -> None:
    event = AuditEvent(
        event_type=AuditEventType.CUSTOM_EVENT,
        # 填充字段...
    )
    await self._add_event(event)
```

---

## 安全性

### 1. 多租户隔离

**实现**:
- 所有数据都包含 `org_id` 和 `user_id`
- 查询时强制过滤
- 审计日志记录租户信息

**示例**:
```python
# 创建上下文时指定租户
context = RuntimeSessionContext(
    org_id="org_123",  # 组织隔离
    user_id="user_456",  # 用户隔离
    # ...
)

# 查询审计日志时过滤
events = await audit_logger.query_events(
    AuditQuery(org_id="org_123")  # 只能查询自己组织的数据
)
```

### 2. 能力验证

**实现**:
- 所有 action 执行前验证是否在能力图内
- 能力图只包含 agent 绑定的 skills
- 只包含已连接的 MCP 服务器

**示例**:
```python
# 在 UnifiedActionExecutor 中验证
if not self.capability_graph.validate_action(tool_name):
    return ToolCallResult(
        success=False,
        error=f"Action '{tool_name}' not in capability graph",
    )
```

### 3. 审批机制

**实现**:
- 高风险操作需要人工审批
- 审批钩子可自定义
- 记录审批结果

**示例**:
```python
# 配置高风险工具
runtime_policy = RuntimePolicy(
    require_approval_for_high_risk=True,
    high_risk_tools=["delete_file", "execute_code"],
)

# 实现审批钩子
async def approval_hook(tool_name: str, params: dict) -> bool:
    # 显示 UI 让用户确认
    return await show_approval_dialog(tool_name, params)

# 使用审批钩子
executor = UnifiedActionExecutor(
    runtime_context=context,
    approval_hook=approval_hook,
)
```

### 4. 审计追踪

**实现**:
- 记录所有 action 执行
- 记录审批流程
- 记录执行元数据

**查询示例**:
```python
# 查询失败的 actions
failed_actions = await audit_logger.query_events(
    AuditQuery(
        org_id="org_123",
        success=False,
    )
)

# 查询被拒绝的 actions
rejected_actions = await audit_logger.query_events(
    AuditQuery(
        org_id="org_123",
        event_types=[AuditEventType.ACTION_REJECTED],
    )
)
```

---

## 性能优化

### 1. 批量写入

**优化点**: 减少 I/O 操作

**实现**:
```python
class AuditLogger:
    def __init__(self, batch_size: int = 100):
        self.batch_size = batch_size
        self._event_buffer: list[AuditEvent] = []

    async def _add_event(self, event: AuditEvent) -> None:
        async with self._lock:
            self._event_buffer.append(event)
            if len(self._event_buffer) >= self.batch_size:
                await self._flush_internal()
```

**效果**: I/O 操作减少 100 倍（batch_size=100）

### 2. 异步处理

**优化点**: 不阻塞主流程

**实现**:
```python
# 所有操作都是异步的
async def execute(self, action: PlanStep) -> ToolCallResult:
    # 异步记录审计日志
    if self.audit_logger:
        await self.audit_logger.log_action_started(...)

    # 异步执行 action
    result = await self._execute_internal(...)

    return result
```

**效果**: 审计日志不影响主流程���能

### 3. 定时刷新

**优化点**: 防止数据丢失

**实现**:
```python
async def _auto_flush_loop(self) -> None:
    while self._running:
        await asyncio.sleep(self.flush_interval)
        await self.flush()
```

**效果**: 平衡性能和数据安全

### 4. 懒加载

**优化点**: 按需构建能力图

**实现**:
```python
# 能力图按需构建
graph = CapabilityGraph(context)
graph.build()  # 只在需要时构建
```

**效果**: 减少不必要的计算

---

## 相关文档

- [API 参考文档](api-reference.md)
- [部署指南](deployment-guide.md)
- [故障排查指南](troubleshooting.md)
- [实施进度总结](implementation-progress.md)
