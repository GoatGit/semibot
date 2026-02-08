# Runtime API 参考文档

本文档提供 Runtime 统一执行链所有公共 API 的详细说明。

## 目录

- [RuntimeSessionContext](#runtimesessioncontext)
- [CapabilityGraph](#capabilitygraph)
- [UnifiedActionExecutor](#unifiedactionexecutor)
- [AuditLogger](#auditlogger)
- [SkillRegistry](#skillregistry)
- [McpClient](#mcpclient)

---

## RuntimeSessionContext

会话级运行时上下文，包含 agent 配置、可用能力和执行策略。

### 类定义

```python
@dataclass
class RuntimeSessionContext:
    """运行时会话上下文"""
    org_id: str
    user_id: str
    agent_id: str
    session_id: str
    agent_config: AgentConfig
    available_skills: list[SkillDefinition] = field(default_factory=list)
    available_tools: list[ToolDefinition] = field(default_factory=list)
    available_mcp_servers: list[McpServerDefinition] = field(default_factory=list)
    runtime_policy: RuntimePolicy = field(default_factory=RuntimePolicy)
    metadata: dict[str, Any] = field(default_factory=dict)
```

### 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `org_id` | `str` | 是 | 组织 ID，用于多租户隔离 |
| `user_id` | `str` | 是 | 用户 ID |
| `agent_id` | `str` | 是 | Agent ID |
| `session_id` | `str` | 是 | 会话 ID，用于追踪和审计 |
| `agent_config` | `AgentConfig` | 是 | Agent 配置（模型、温度等） |
| `available_skills` | `list[SkillDefinition]` | 否 | 可用的 skills 列表 |
| `available_tools` | `list[ToolDefinition]` | 否 | 可用的 tools 列表 |
| `available_mcp_servers` | `list[McpServerDefinition]` | 否 | 可用的 MCP 服务器列表 |
| `runtime_policy` | `RuntimePolicy` | 否 | 运行时策略（超时、重试等） |
| `metadata` | `dict[str, Any]` | 否 | 额外的元数据 |

### 方法

#### `has_capability(name: str) -> bool`

检查是否有指定名称的能力。

**参数**:
- `name`: 能力名称

**返回**: `True` 如果能力存在，否则 `False`

**示例**:
```python
if context.has_capability("search_web"):
    print("Agent has search_web capability")
```

#### `get_skill_by_name(name: str) -> SkillDefinition | None`

根据名称获取 skill 定义。

**参数**:
- `name`: Skill 名称

**返回**: `SkillDefinition` 对象或 `None`

**示例**:
```python
skill = context.get_skill_by_name("search_web")
if skill:
    print(f"Found skill: {skill.description}")
```

#### `get_all_capability_names() -> list[str]`

获取所有能力的名称列表。

**返回**: 能力名称列表

**示例**:
```python
capabilities = context.get_all_capability_names()
print(f"Available capabilities: {', '.join(capabilities)}")
```

#### `get_connected_mcp_servers() -> list[McpServerDefinition]`

获取所有已连接的 MCP 服务器。

**返回**: 已连接的 MCP 服务器列表

**示例**:
```python
connected_servers = context.get_connected_mcp_servers()
for server in connected_servers:
    print(f"Connected to: {server.name}")
```

### 使用示例

```python
from src.orchestrator.context import (
    RuntimeSessionContext,
    AgentConfig,
    SkillDefinition,
    RuntimePolicy,
)

# 创建上下文
context = RuntimeSessionContext(
    org_id="org_123",
    user_id="user_456",
    agent_id="agent_789",
    session_id="session_abc",
    agent_config=AgentConfig(
        id="agent_789",
        name="My Agent",
        model="claude-3-5-sonnet-20241022",
        temperature=0.7,
    ),
    available_skills=[
        SkillDefinition(
            id="skill_1",
            name="search_web",
            description="Search the web",
            version="1.0.0",
        ),
    ],
    runtime_policy=RuntimePolicy(
        max_iterations=10,
        require_approval_for_high_risk=True,
        high_risk_tools=["delete_file", "execute_code"],
    ),
)

# 使用上下文
if context.has_capability("search_web"):
    print("Can search the web")
```

---

## CapabilityGraph

能力图，动态构建和管理 agent 可用的所有能力。

### 类定义

```python
class CapabilityGraph:
    """能力图，管理所有可用能力"""

    def __init__(self, context: RuntimeSessionContext):
        """初始化能力图"""
        self.context = context
        self.capabilities: dict[str, Capability] = {}
```

### 方法

#### `build() -> None`

从 RuntimeSessionContext 构建能力图。

**说明**:
- 自动从 context 中的 skills、tools、MCP servers 构建能力图
- 只包含已连接的 MCP 服务器
- 幂等操作，可以多次调用

**示例**:
```python
graph = CapabilityGraph(context)
graph.build()
```

#### `get_schemas_for_planner() -> list[dict[str, Any]]`

生成 LLM planner 可见的 schema 列表。

**返回**: Schema 列表，每个 schema 包含 name、description、parameters 等字段

**示例**:
```python
schemas = graph.get_schemas_for_planner()
# 传递给 planner
planner_agent.plan(task, available_tools=schemas)
```

#### `validate_action(action_name: str) -> bool`

验证 action 是否在能力图内。

**参数**:
- `action_name`: Action 名称

**返回**: `True` 如果 action 有效，否则 `False`

**示例**:
```python
if graph.validate_action("search_web"):
    # 执行 action
    result = executor.execute(action)
else:
    print("Invalid action")
```

#### `get_capability(name: str) -> Capability | None`

获取指定名称的能力。

**参数**:
- `name`: 能力名称

**返回**: `Capability` 对象或 `None`

**示例**:
```python
capability = graph.get_capability("search_web")
if capability:
    print(f"Type: {capability.capability_type}")
    print(f"Description: {capability.description}")
```

#### `list_capabilities() -> list[str]`

列出所有能力名称。

**返回**: 能力名称列表

**示例**:
```python
capabilities = graph.list_capabilities()
print(f"Available: {', '.join(capabilities)}")
```

#### `get_capabilities_by_type(capability_type: str) -> list[Capability]`

按类型获取能力列表。

**参数**:
- `capability_type`: 能力类型（"skill"、"tool"、"mcp"）

**返回**: 指定类型的能力列表

**示例**:
```python
skills = graph.get_capabilities_by_type("skill")
print(f"Found {len(skills)} skills")
```

### 使用示例

```python
from src.orchestrator.capability import CapabilityGraph

# 创建能力图
graph = CapabilityGraph(context)
graph.build()

# 获取 planner schemas
schemas = graph.get_schemas_for_planner()

# 验证 action
if graph.validate_action("search_web"):
    print("Action is valid")

# 列出所有能力
capabilities = graph.list_capabilities()
print(f"Available capabilities: {capabilities}")

# 按类型获取能力
skills = graph.get_capabilities_by_type("skill")
mcp_tools = graph.get_capabilities_by_type("mcp")
```

---

## UnifiedActionExecutor

统一执行器，提供单一入口点执行所有类型的 actions。

### 类定义

```python
class UnifiedActionExecutor:
    """统一 action 执行器"""

    def __init__(
        self,
        runtime_context: RuntimeSessionContext,
        skill_registry: SkillRegistry | None = None,
        mcp_client: McpClient | None = None,
        approval_hook: Callable[[str, dict], Awaitable[bool]] | None = None,
        audit_logger: AuditLogger | None = None,
    ):
        """初始化执行器"""
```

### 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `runtime_context` | `RuntimeSessionContext` | 是 | 运行时上下文 |
| `skill_registry` | `SkillRegistry` | 否 | Skill 注册表 |
| `mcp_client` | `McpClient` | 否 | MCP 客户端 |
| `approval_hook` | `Callable` | 否 | 审批钩子函数 |
| `audit_logger` | `AuditLogger` | 否 | 审计日志记录器 |

### 方法

#### `async execute(action: PlanStep) -> ToolCallResult`

执行 action。

**参数**:
- `action`: 要执行的 action（PlanStep 对象）

**返回**: `ToolCallResult` 对象，包含执行结果

**说明**:
- 自动验证 action 是否在能力图内
- 高风险操作会触发审批流程
- 记录审计日志（如果配置了 audit_logger）
- 捕获执行元数据

**示例**:
```python
from src.orchestrator.state import PlanStep

action = PlanStep(
    id="step_1",
    title="Search the web",
    tool="search_web",
    params={"query": "Python tutorials"},
)

result = await executor.execute(action)

if result.success:
    print(f"Result: {result.result}")
else:
    print(f"Error: {result.error}")
```

### 执行流程

1. **验证**: 检查 action 是否在能力图内
2. **审批**: 如果是高风险操作，调用审批钩子
3. **路由**: 根据能力类型路由到正确的执行器
   - Skill → SkillRegistry
   - Tool → 内置工具
   - MCP → McpClient
4. **执行**: 执行 action
5. **审计**: 记录审计日志
6. **返回**: 返回结果（包含元数据）

### 使用示例

```python
from src.orchestrator.unified_executor import UnifiedActionExecutor
from src.skills.registry import SkillRegistry
from src.audit.logger import AuditLogger
from src.audit.storage import InMemoryAuditStorage

# 创建依赖
skill_registry = SkillRegistry()
audit_storage = InMemoryAuditStorage()
audit_logger = AuditLogger(storage=audit_storage)

# 审批钩子
async def approval_hook(tool_name: str, params: dict) -> bool:
    print(f"Approval requested for {tool_name}")
    # 实际应用中，这里会弹出 UI 让用户确认
    return True

# 创建执行器
executor = UnifiedActionExecutor(
    runtime_context=context,
    skill_registry=skill_registry,
    approval_hook=approval_hook,
    audit_logger=audit_logger,
)

# 执行 action
action = PlanStep(
    id="step_1",
    title="Search the web",
    tool="search_web",
    params={"query": "Python tutorials"},
)

result = await executor.execute(action)

if result.success:
    print(f"Success: {result.result}")
    print(f"Metadata: {result.metadata}")
else:
    print(f"Failed: {result.error}")
```

---

## AuditLogger

审计日志记录器，记录所有 action 执行事件。

### 类定义

```python
class AuditLogger:
    """审计日志记录器"""

    def __init__(
        self,
        storage: AuditStorage,
        batch_size: int = AUDIT_EVENT_BATCH_SIZE,
        flush_interval: float = AUDIT_EVENT_FLUSH_INTERVAL,
    ):
        """初始化审计 logger"""
```

### 参数说明

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `storage` | `AuditStorage` | 是 | 审计存储后端 |
| `batch_size` | `int` | 否 | 批量写入大小（默认 100） |
| `flush_interval` | `float` | 否 | 刷新间隔秒数（默认 5.0） |

### 方法

#### `async start() -> None`

启动审计 logger（��动后台刷新任务）。

**示例**:
```python
await audit_logger.start()
```

#### `async stop() -> None`

停止审计 logger（刷新所有待处理事件）。

**示例**:
```python
await audit_logger.stop()
```

#### `async flush() -> None`

手动刷新缓冲区中的事件到存储。

**示例**:
```python
await audit_logger.flush()
```

#### `async log_action_started(...) -> None`

记录 action 开始事件。

**参数**:
- `context`: RuntimeSessionContext
- `action_id`: Action ID
- `action_name`: Action 名称
- `action_params`: Action 参数
- `metadata`: ExecutionMetadata

**示例**:
```python
await audit_logger.log_action_started(
    context=context,
    action_id="action_1",
    action_name="search_web",
    action_params={"query": "Python"},
    metadata=metadata,
)
```

#### `async log_action_completed(...) -> None`

记录 action 完成事件。

**参数**:
- `context`: RuntimeSessionContext
- `action_id`: Action ID
- `action_name`: Action 名称
- `action_params`: Action 参数
- `metadata`: ExecutionMetadata
- `duration_ms`: 执行时间（毫秒）
- `result`: 执行结果（可选）

**示例**:
```python
await audit_logger.log_action_completed(
    context=context,
    action_id="action_1",
    action_name="search_web",
    action_params={"query": "Python"},
    metadata=metadata,
    duration_ms=150,
    result={"results": [...]},
)
```

#### `async log_action_failed(...) -> None`

记录 action 失败事件。

**参数**:
- `context`: RuntimeSessionContext
- `action_id`: Action ID
- `action_name`: Action 名称
- `action_params`: Action 参数
- `metadata`: ExecutionMetadata
- `duration_ms`: 执行时间（毫秒）
- `error`: 错误信息

**示例**:
```python
await audit_logger.log_action_failed(
    context=context,
    action_id="action_1",
    action_name="search_web",
    action_params={"query": "Python"},
    metadata=metadata,
    duration_ms=50,
    error="Network timeout",
)
```

#### `async query_events(query: AuditQuery) -> list[AuditEvent]`

查询审计事件。

**参数**:
- `query`: AuditQuery 对象，包含查询条件

**返回**: 匹配的审计事件列表

**示例**:
```python
from src.audit.models import AuditQuery, AuditEventType

# 查询失败的 actions
events = await audit_logger.query_events(
    AuditQuery(
        session_id="session_abc",
        success=False,
    )
)

# 查询特定类型的事件
events = await audit_logger.query_events(
    AuditQuery(
        org_id="org_123",
        event_types=[AuditEventType.ACTION_COMPLETED],
        limit=100,
    )
)
```

#### `async count_events(query: AuditQuery) -> int`

统计审计事件数量。

**参数**:
- `query`: AuditQuery 对象

**返回**: 匹配的事件数量

**示例**:
```python
count = await audit_logger.count_events(
    AuditQuery(agent_id="agent_789")
)
print(f"Total events: {count}")
```

### 使用示例

```python
from src.audit.logger import AuditLogger
from src.audit.storage import FileAuditStorage
from src.audit.models import AuditQuery, AuditEventType

# 创建存储
storage = FileAuditStorage(
    directory="/var/log/semibot/audit",
    max_file_size=100 * 1024 * 1024,  # 100MB
)

# 创建 logger
audit_logger = AuditLogger(
    storage=storage,
    batch_size=1000,
    flush_interval=10.0,
)

# 启动
await audit_logger.start()

try:
    # 记录事件
    await audit_logger.log_action_started(...)
    await audit_logger.log_action_completed(...)

    # 查询事件
    events = await audit_logger.query_events(
        AuditQuery(
            session_id="session_abc",
            event_types=[AuditEventType.ACTION_COMPLETED],
        )
    )

    for event in events:
        print(f"{event.timestamp}: {event.action_name}")

finally:
    # 停止（会刷新所有待处理事件）
    await audit_logger.stop()
```

---

## SkillRegistry

Skill 注册表，管理所有可用的 skills。

### 类定义

```python
class SkillRegistry:
    """Skill 注册表"""

    def __init__(self):
        """初始化注册表"""
        self._skills: dict[str, BaseSkill] = {}
        self._skill_metadata: dict[str, SkillMetadata] = {}
```

### 方法

#### `register_skill(skill: BaseSkill, metadata: SkillMetadata | None = None) -> None`

注册一个 skill。

**参数**:
- `skill`: BaseSkill 实例
- `metadata`: SkillMetadata（可选）

**示例**:
```python
from src.skills.base import BaseSkill
from src.skills.registry import SkillRegistry, SkillMetadata

class SearchSkill(BaseSkill):
    name = "search_web"
    description = "Search the web"

    async def execute(self, **kwargs):
        # 实现搜索逻辑
        pass

registry = SkillRegistry()
registry.register_skill(
    SearchSkill(),
    metadata=SkillMetadata(
        version="1.0.0",
        source="local",
        author="Your Name",
    ),
)
```

#### `get_skill(name: str) -> BaseSkill | None`

获取指定名称的 skill。

**参数**:
- `name`: Skill 名称

**返回**: BaseSkill 实例或 None

**示例**:
```python
skill = registry.get_skill("search_web")
if skill:
    result = await skill.execute(query="Python")
```

#### `get_skill_metadata(name: str) -> SkillMetadata | None`

获取 skill 的元数据。

**参数**:
- `name`: Skill 名称

**返回**: SkillMetadata 或 None

**示例**:
```python
metadata = registry.get_skill_metadata("search_web")
if metadata:
    print(f"Version: {metadata.version}")
    print(f"Source: {metadata.source}")
```

#### `list_skills() -> list[str]`

列出所有已注册的 skill 名称。

**返回**: Skill 名称列表

**示例**:
```python
skills = registry.list_skills()
print(f"Available skills: {', '.join(skills)}")
```

#### `async execute(name: str, **kwargs) -> ToolResult`

执行指定的 skill。

**参数**:
- `name`: Skill 名称
- `**kwargs`: Skill 参数

**返回**: ToolResult 对象

**示例**:
```python
result = await registry.execute(
    "search_web",
    query="Python tutorials",
)

if result.success:
    print(result.result)
```

---

## McpClient

MCP 客户端，管理与 MCP 服务器的连接和通信。

### 类定义

```python
class McpClient:
    """MCP 客户端"""

    def __init__(self):
        """初始化客户端"""
        self._servers: dict[str, McpServerConfig] = {}
        self._connections: dict[str, Any] = {}
```

### 方法

#### `add_server(server_id: str, config: McpServerConfig) -> None`

添加 MCP 服务器配置。

**参数**:
- `server_id`: 服务器 ID
- `config`: McpServerConfig 对象

**示例**:
```python
from src.mcp.client import McpClient
from src.mcp.models import McpServerConfig

client = McpClient()
client.add_server(
    "server_1",
    McpServerConfig(
        server_id="server_1",
        name="File System",
        endpoint="stdio",
        transport="stdio",
        config={"command": "mcp-server-filesystem"},
    ),
)
```

#### `async connect(server_id: str) -> bool`

连接到 MCP 服务器。

**参数**:
- `server_id`: 服务器 ID

**返回**: `True` 如果连接成功

**示例**:
```python
success = await client.connect("server_1")
if success:
    print("Connected to MCP server")
```

#### `async disconnect(server_id: str) -> None`

断开与 MCP 服务器的连接。

**参数**:
- `server_id`: 服务器 ID

**示例**:
```python
await client.disconnect("server_1")
```

#### `async call_tool(server_id: str, tool_call: McpToolCall) -> McpToolResult`

调用 MCP 工具。

**参数**:
- `server_id`: 服务器 ID
- `tool_call`: McpToolCall 对象

**返回**: McpToolResult 对象

**示例**:
```python
from src.mcp.models import McpToolCall

result = await client.call_tool(
    "server_1",
    McpToolCall(
        tool_name="read_file",
        arguments={"path": "/path/to/file.txt"},
    ),
)

if result.success:
    print(result.content)
```

#### `get_connection_status(server_id: str) -> McpConnectionStatus`

获取服务器连接状态。

**参数**:
- `server_id`: 服务器 ID

**返回**: McpConnectionStatus 枚举值

**示例**:
```python
from src.mcp.models import McpConnectionStatus

status = client.get_connection_status("server_1")
if status == McpConnectionStatus.CONNECTED:
    print("Server is connected")
```

---

## 数据模型

### AgentConfig

```python
@dataclass
class AgentConfig:
    id: str
    name: str
    model: str = "claude-3-5-sonnet-20241022"
    temperature: float = 0.7
    max_tokens: int = 4096
```

### RuntimePolicy

```python
@dataclass
class RuntimePolicy:
    max_iterations: int = 10
    timeout_seconds: int = 300
    require_approval_for_high_risk: bool = False
    high_risk_tools: list[str] = field(default_factory=list)
    max_concurrent_actions: int = 5
```

### SkillDefinition

```python
@dataclass
class SkillDefinition:
    id: str
    name: str
    description: str
    version: str = "1.0.0"
    source: str = "local"
    input_schema: dict[str, Any] = field(default_factory=dict)
    output_schema: dict[str, Any] = field(default_factory=dict)
```

### ExecutionMetadata

```python
@dataclass
class ExecutionMetadata:
    capability_type: str  # "skill" / "tool" / "mcp"
    source: str | None = None  # "local" / "anthropic" / "custom"
    version: str | None = None
    mcp_server_id: str | None = None
    mcp_server_name: str | None = None
    requires_approval: bool = False
    is_high_risk: bool = False
```

### AuditEvent

```python
@dataclass
class AuditEvent:
    event_id: str
    event_type: AuditEventType
    timestamp: datetime
    org_id: str
    user_id: str
    agent_id: str
    session_id: str
    action_id: str
    action_name: str
    action_params: dict[str, Any]
    capability_type: str | None = None
    capability_source: str | None = None
    capability_version: str | None = None
    success: bool | None = None
    duration_ms: int = 0
    error_message: str | None = None
    severity: AuditSeverity = AuditSeverity.INFO
```

---

## 错误处理

所有异步方法都可能抛出以下异常：

- `ValueError`: 参数无效
- `RuntimeError`: 运行时错误
- `TimeoutError`: 操作超时
- `ConnectionError`: 连接错误（MCP）

建议使用 try-except 捕获异常：

```python
try:
    result = await executor.execute(action)
except ValueError as e:
    logger.error(f"Invalid action: {e}")
except TimeoutError as e:
    logger.error(f"Action timeout: {e}")
except Exception as e:
    logger.error(f"Unexpected error: {e}")
```

---

## 最佳实践

### 1. 始终使用 RuntimeSessionContext

```python
# ✅ 好的做法
context = RuntimeSessionContext(
    org_id=org_id,
    user_id=user_id,
    agent_id=agent_id,
    session_id=session_id,
    agent_config=agent_config,
)

# ❌ 不好的做法
# 不要跳过 context，直接使用 skill_registry
```

### 2. 使用 CapabilityGraph 验证

```python
# ✅ 好的做法
graph = CapabilityGraph(context)
graph.build()
if graph.validate_action(action_name):
    result = await executor.execute(action)

# ❌ 不好的做法
# 不要跳过验证直接执行
```

### 3. 启用审计日志

```python
# ✅ 好的做法
audit_logger = AuditLogger(storage)
await audit_logger.start()
executor = UnifiedActionExecutor(
    runtime_context=context,
    audit_logger=audit_logger,
)

# ❌ 不好的做法
# 生产环境不要禁用审计日志
```

### 4. 正确处理审批

```python
# ✅ 好的做法
async def approval_hook(tool_name: str, params: dict) -> bool:
    # 显示 UI 让用户确认
    return await show_approval_dialog(tool_name, params)

executor = UnifiedActionExecutor(
    runtime_context=context,
    approval_hook=approval_hook,
)

# ❌ 不好的做法
# 不要在审批钩子中直接返回 True
```

### 5. 优雅关闭

```python
# ✅ 好的做法
try:
    await audit_logger.start()
    # 执行操作
finally:
    await audit_logger.stop()  # 确保刷新所有事件

# ❌ 不好的做法
# 不要忘记调用 stop()
```

---

## 相关文档

- [架构设计文档](architecture.md)
- [部署指南](deployment-guide.md)
- [故障排查指南](troubleshooting.md)
- [使用示例](examples/)
