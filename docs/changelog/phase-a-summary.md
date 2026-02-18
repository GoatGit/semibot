# 阶段 A 实施总结：Bootstrap 上下文注入

## 实施日期
2026-02-09

## 目标
在 session 启动时构建完整的上下文，为后续的能力图和统一执行器奠定基础。

## 已完成的工作

### 1. 创建 RuntimeSessionContext 定义 ✅

**文件**: `runtime/src/orchestrator/context.py`

创建了以下数据类：
- `AgentConfig`: Agent 配置
- `SkillDefinition`: Skill 定义（包含版本和来源元数据）
- `ToolDefinition`: Tool 定义
- `McpServerDefinition`: MCP Server 定义
- `RuntimePolicy`: Runtime 执行策略
- `RuntimeSessionContext`: 会话级上下文（核心类）

**关键特性**:
- 包含所有必需的标识符（org_id, user_id, agent_id, session_id）
- 包含 agent 配置和能力清单（skills, tools, mcp_servers）
- 提供便捷方法：
  - `get_all_capability_names()`: 获取所有能力名称
  - `has_capability(name)`: 检查能力是否可用
  - `get_skill_by_name(name)`: 根据名称获取 skill
  - `get_tool_by_name(name)`: 根据名称获取 tool
  - `get_connected_mcp_servers()`: 获取已连接的 MCP servers

### 2. 扩展 AgentState 添加 context 字段 ✅

**文件**: `runtime/src/orchestrator/state.py`

**修改内容**:
- 在 `AgentState` TypedDict 中添加 `context: RuntimeSessionContext` 字段
- 修改 `create_initial_state()` 函数接受 `context` 参数
- 添加 TYPE_CHECKING 导入以避免循环依赖

**影响**:
- 所有节点现在都可以通过 `state["context"]` 访问完整的会话上下文
- 向后兼容性：现有代码仍然可以访问 `state["org_id"]`, `state["agent_id"]` 等字段

### 3. 修改 graph 创建逻辑注入 context ✅

**文件**: `runtime/src/orchestrator/graph.py`

**修改内容**:
- `create_agent_graph()` 新增 `runtime_context` 参数
- `create_agent_graph_with_checkpointer()` 新增 `runtime_context` 参数
- 更新文档字符串，添加使用示例
- 添加 TYPE_CHECKING 导入

**设计说明**:
- `runtime_context` 参数是可选的，保持向后兼容
- context 通过闭包传递给所有节点
- 节点可以从 `state["context"]` 访问 runtime context

### 4. 更新配置常量文件 ✅

**文件**: `runtime/src/constants/config.py`

**新增常量**:

**Capability Graph**:
- `CAPABILITY_CACHE_TTL = 300`: 能力图缓存 TTL（秒）
- `MAX_SKILLS_PER_AGENT = 50`: 每个 Agent 最多绑定的 Skills 数量
- `MAX_MCP_SERVERS_PER_ORG = 20`: 每个组织最多的 MCP Servers 数量

**Audit Events**:
- `AUDIT_EVENT_BATCH_SIZE = 100`: 审计事件批量写入大小
- `AUDIT_EVENT_FLUSH_INTERVAL = 5`: 审计事件刷新间隔（秒）
- `AUDIT_RETENTION_DAYS = 90`: 审计事件保留天数

**MCP Client**:
- `MCP_CONNECTION_TIMEOUT = 10`: MCP 连接超时（秒）
- `MCP_CALL_TIMEOUT = 30`: MCP 调用超时（秒）
- `MCP_RECONNECT_DELAY = 5`: MCP 重连延迟（秒）
- `MCP_MAX_RETRIES = 3`: MCP 最大重试次数

### 5. 更新模块导出 ✅

**文件**:
- `runtime/src/orchestrator/__init__.py`
- `runtime/src/__init__.py`

**新增导出**:
- `RuntimeSessionContext`
- `create_initial_state`

### 6. 创建测试 ✅

**文件**: `runtime/tests/orchestrator/test_context.py`

**测试覆盖**:
- ✅ RuntimeSessionContext 创建
- ✅ 能力方法（get_all_capability_names, has_capability, etc.）
- ✅ create_initial_state 与 context 集成
- ✅ 从 AgentState 访问 context
- ✅ RuntimePolicy 默认值和自定义值

**测试结果**: 6/6 通过 ✅

### 7. 创建集成文档 ✅

**文件**: `docs/runtime-integration-example.md`

包含：
- API 层集成示例（TypeScript）
- Python Runtime 入口示例
- 验证清单

## 验收标准

- [x] RuntimeSessionContext 包含所有必需字段
- [x] AgentState 包含 context 字段
- [x] 所有节点都能访问 context（通过 state["context"]）
- [x] 配置常量已添加
- [x] 模块导出已更新
- [x] 测试已创建并通过
- [ ] API 层能正确构建和传递 context（需要实际集成，已提供示例）

## 架构改进

### 优点
1. **统一上下文**: 所有执行相关的信息集中在一个地方
2. **类型安全**: 使用 dataclass 提供类型检查
3. **可扩展**: 易于添加新的能力类型（如 MCP）
4. **便捷方法**: 提供常用的查询方法，简化节点代码
5. **向后兼容**: 不破坏现有代码

### 设计决策
1. **使用 dataclass**: 提供不可变性和类型安全
2. **TYPE_CHECKING**: 避免循环导入问题
3. **可选参数**: `runtime_context` 参数可选，保持向后兼容
4. **分离关注点**: context 定义在独立文件中

## 下一步：阶段 B

**目标**: 能力图与 planner 对齐

**关键任务**:
1. 创建 `CapabilityGraph` 类
2. 实现 `build()` 方法：从 context 构建能力图
3. 实现 `get_schemas_for_planner()` 方法：生成 LLM 可见的 schema
4. 实现 `validate_action()` 方法：验证 action 是否在图内
5. 修改 `PlannerAgent` 使用 `capability_graph`
6. 在 ACT 节点添加 action 验证逻辑

## 文件清单

### 新建文件
- `runtime/src/orchestrator/context.py` (148 行)
- `runtime/tests/orchestrator/test_context.py` (186 行)
- `docs/runtime-integration-example.md` (文档)

### 修改文件
- `runtime/src/orchestrator/state.py` (+4 行)
- `runtime/src/orchestrator/graph.py` (+10 行)
- `runtime/src/constants/config.py` (+48 行)
- `runtime/src/orchestrator/__init__.py` (+12 行)
- `runtime/src/__init__.py` (+8 行)

### 总计
- 新增代码: ~400 行
- 修改代码: ~80 行
- 测试: 6 个测试用例，100% 通过

## 风险和缓解

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|---------|------|
| 循环导入 | 编译错误 | 使用 TYPE_CHECKING | ✅ 已解决 |
| 向后兼容 | 破坏现有代码 | 参数可选，保留旧字段 | ✅ 已解决 |
| 测试覆盖不足 | 隐藏 bug | 创建全面的单元测试 | ✅ 已完成 |

## 总结

阶段 A 已成功完成，为 Runtime 统一执行链奠定了坚实的基础。RuntimeSessionContext 现在包含了所有必要的会话信息，并且可以在整个执行图中访问。下一步将构建 CapabilityGraph，实现能力的动态管理和验证。
