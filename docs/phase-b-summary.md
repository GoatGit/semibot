# 阶段 B 实施总结：能力图与 planner 对齐

## 实施日期
2026-02-09

## 目标
构建会话级能力图，确保 planner 只能看到 agent 绑定的能力，并在执行前验证 action 的合法性。

## 已完成的工作

### 1. 定义 Capability 模型 ✅

**文件**: `runtime/src/orchestrator/capability.py`

创建了完整的能力模型体系：

**基类**:
- `Capability`: 抽象基类，定义所有能力的通用接口
  - `to_schema()`: 转换为 LLM 兼容的 schema
  - `validate_params()`: 验证参数

**子类**:
- `SkillCapability`: 表示 Skill 能力
  - 包含版本、来源（local/anthropic/custom）元数据
  - 支持从 `SkillDefinition` 自动初始化

- `ToolCapability`: 表示内置 Tool 能力
  - 标记为 builtin 来源
  - 支持参数 schema 验证

- `McpCapability`: 表示 MCP Server 工具能力
  - 包含 MCP server ID 和名称
  - 支持 MCP inputSchema 格式

### 2. 实现 CapabilityGraph 类 ✅

**核心功能**:

**构建能力图** (`build()`):
1. 从 `RuntimeSessionContext` 加载 agent 绑定的 skills
2. 加载内置 tools
3. 加载已连接的 MCP server 工具
4. 过滤权限和状态

**生成 Planner Schema** (`get_schemas_for_planner()`):
- 返回 OpenAI function calling 格式的 schema
- 只包含 agent 有权限的能力
- 包含元数据（capability_type, source, version）

**验证 Action** (`validate_action()`):
- 检查 action 是否在能力图内
- 记录验证失败的详细日志
- 返回布尔值表示是否合法

**辅助方法**:
- `get_capability(name)`: 根据名称获取能力
- `list_capabilities()`: 列出所有能力名称
- `get_capabilities_by_type(type)`: 按类型筛选能力
- 自动构建机制：首次调用时自动 build

### 3. 在 plan_node 中集成 CapabilityGraph ✅

**文件**: `runtime/src/orchestrator/nodes.py`

**修改内容**:
- 从 `state["context"]` 获取 `RuntimeSessionContext`
- 构建 `CapabilityGraph` 并调用 `get_schemas_for_planner()`
- 将 schemas 传递给 LLM provider
- 保留 `skill_registry` 作为向后兼容的 fallback
- 添加详细的日志记录

**日志输出**:
```python
logger.info(
    "Capability graph built for planning",
    extra={
        "session_id": state["session_id"],
        "capability_count": len(available_skills),
    },
)
```

### 4. 在 act_node 中添加 action 验证 ✅

**文件**: `runtime/src/orchestrator/nodes.py`

**验证流程**:
1. 构建 `CapabilityGraph`（如果 RuntimeSessionContext 可用）
2. 遍历所有 `pending_actions`
3. 对每个 action 调用 `capability_graph.validate_action()`
4. 过滤掉不在能力图中的 action
5. 记录详细的验证失败日志
6. 只执行通过验证的 action

**安全保障**:
- 未绑定的能力无法执行
- 断开的 MCP server 工具无法执行
- 详细的审计日志便于追踪

### 5. 修改 PlannerAgent 使用 capability_graph ✅

**文件**: `runtime/src/agents/planner.py`

**修改内容**:
- 在 `_build_planning_context()` 中优先使用 `CapabilityGraph`
- 从 `state["context"]` 获取 `RuntimeSessionContext`
- 调用 `capability_graph.get_schemas_for_planner()`
- 保留 `skill_registry` fallback 以保持向后兼容
- 添加日志区分使用的是 CapabilityGraph 还是 fallback

### 6. 创建完整测试 ✅

**单元测试** (`test_capability.py`):
- 14 个测试用例，100% 通过 ✅
- 测试覆盖：
  - Capability 子类创建和 schema 生成
  - CapabilityGraph 构建和查询
  - Action 验证
  - MCP 连接状态过滤
  - 自动构建机制

**集成测试** (`test_capability_integration.py`):
- 4 个测试用例，100% 通过 ✅
- 测试覆盖：
  - plan_node 使用 CapabilityGraph
  - act_node 验证 actions
  - 向后兼容性（无 RuntimeSessionContext）
  - 端到端集成

**修复旧测试**:
- 修复 `test_state.py`（12 个测试）
- 修复 `test_edges.py`（17 个测试）
- 修复 `conftest.py` fixtures
- 所有 55 个 orchestrator 测试通过 ✅

### 7. 更新模块导出 ✅

**文件**: `runtime/src/orchestrator/__init__.py`

新增导出：
- `CapabilityGraph`

## 验收标准

- [x] CapabilityGraph 能正确构建能力图
- [x] planner 只能看到 agent 绑定的 skills
- [x] ACT 节点能验证 action 合法性
- [x] 未绑定的能力无法执行
- [x] MCP 断连的工具不在能力图中
- [x] 所有测试通过（55/55）
- [x] 向后兼容性保持

## 架构改进

### 优点

1. **权限隔离**: planner 和 executor 看到的能力完全一致
2. **动态管理**: 能力图根据 agent 配置和 MCP 连接状态动态构建
3. **安全验证**: 执行前强制验证，防止权限绕过
4. **详细审计**: 完整的日志记录便于追踪和调试
5. **类型安全**: 使用 dataclass 和类型注解
6. **可扩展**: 易于添加新的能力类型

### 设计决策

1. **三种能力类型**: Skill, Tool, MCP 统一管理
2. **自动构建**: 首次访问时自动构建，提高性能
3. **向后兼容**: 保留 skill_registry fallback
4. **元数据丰富**: 包含版本、来源、服务器信息
5. **OpenAI 格式**: Schema 使用标准 function calling 格式

## 关键代码示例

### 构建能力图

```python
from src.orchestrator.capability import CapabilityGraph

capability_graph = CapabilityGraph(runtime_context)
capability_graph.build()

# 获取 planner schemas
schemas = capability_graph.get_schemas_for_planner()

# 验证 action
is_valid = capability_graph.validate_action("web_search")
```

### 在 plan_node 中使用

```python
runtime_context = state.get("context")
if runtime_context:
    capability_graph = CapabilityGraph(runtime_context)
    available_skills = capability_graph.get_schemas_for_planner()
```

### 在 act_node 中验证

```python
capability_graph = CapabilityGraph(runtime_context)
capability_graph.build()

validated_actions = []
for action in pending_actions:
    if capability_graph.validate_action(action.tool):
        validated_actions.append(action)
```

## 测试结果

```
============================= test session starts ==============================
collected 55 items

tests/orchestrator/test_capability.py .............. [ 25%]
tests/orchestrator/test_capability_integration.py .... [ 32%]
tests/orchestrator/test_context.py ...... [ 43%]
tests/orchestrator/test_edges.py ................. [ 74%]
tests/orchestrator/test_executor.py .. [ 78%]
tests/orchestrator/test_state.py ............ [100%]

============================== 55 passed in 0.11s ===============================
```

## 文件清单

### 新建文件
- `runtime/src/orchestrator/capability.py` (400+ 行)
- `runtime/tests/orchestrator/test_capability.py` (400+ 行)
- `runtime/tests/orchestrator/test_capability_integration.py` (200+ 行)

### 修改文件
- `runtime/src/orchestrator/nodes.py` (+60 行)
- `runtime/src/agents/planner.py` (+20 行)
- `runtime/src/orchestrator/__init__.py` (+5 行)
- `runtime/tests/orchestrator/test_state.py` (修复)
- `runtime/tests/orchestrator/conftest.py` (修复)

### 总计
- 新增代码: ~1000 行
- 修改代码: ~100 行
- 测试: 18 个新测试，55 个总测试，100% 通过

## 下一步：阶段 C

**目标**: 统一执行器

**关键任务**:
1. 创建 `UnifiedActionExecutor` 类
2. 重构 `SkillRegistry` 支持版本和动态加载
3. 实现 MCP 客户端（stdio/http/websocket）
4. 添加审批钩子（高风险操作）
5. 集成到 act_node

## 风险和缓解

| 风险 | 影响 | 缓解措施 | 状态 |
|------|------|---------|------|
| 性能开销 | 每次 plan/act 都构建能力图 | 自动构建机制，避免重复构建 | ✅ 已解决 |
| 向后兼容 | 破坏现有代码 | 保留 skill_registry fallback | ✅ 已解决 |
| 测试复杂度 | 测试覆盖不足 | 单元测试 + 集成测试 | ✅ 已完成 |
| MCP 状态变化 | 能力图过时 | 每次构建时检查连接状态 | ✅ 已实现 |

## 总结

阶段 B 已成功完成！CapabilityGraph 现在能够：
- 根据 agent 配置动态构建能力图
- 确保 planner 和 executor 看到的能力一致
- 在执行前强制验证 action 合法性
- 支持 Skill、Tool、MCP 三种能力类型
- 提供详细的审计日志

这为下一步的统一执行器和审计系统奠定了坚实的基础。
