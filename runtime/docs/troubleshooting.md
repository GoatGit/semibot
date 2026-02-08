# Runtime 统一执行链故障排查指南

## 目录

- [常见问题](#常见问题)
- [错误信息解析](#错误信息解析)
- [排查步骤](#排查步骤)
- [调试技巧](#调试技巧)
- [性能问题](#性能问题)
- [联系支持](#联系支持)

---

## 常见问题

### 1. RuntimeSessionContext 创建失败

#### 症状

```python
ValueError: org_id is required
```

#### 原因

缺少必需的字段。

#### 解决方案

```python
# ❌ 错误
context = RuntimeSessionContext(
    agent_id="agent_123",
    # 缺少 org_id, user_id, session_id
)

# ✅ 正确
context = RuntimeSessionContext(
    org_id="org_123",
    user_id="user_456",
    agent_id="agent_789",
    session_id="session_abc",
    agent_config=AgentConfig(
        id="agent_789",
        name="My Agent",
    ),
)
```

---

### 2. CapabilityGraph 构建失败

#### 症状

```python
AttributeError: 'NoneType' object has no attribute 'available_skills'
```

#### 原因

RuntimeSessionContext 未正确传递。

#### 解决方案

```python
# ❌ 错误
graph = CapabilityGraph(None)
graph.build()

# ✅ 正确
graph = CapabilityGraph(context)
graph.build()
```

---

### 3. Action 验证失败

#### 症状

```
Action 'unknown_tool' not in capability graph
```

#### 原因

Action 不在能力图内。

#### 排查步骤

1. **检查能力图**

```python
graph = CapabilityGraph(context)
graph.build()

# 列出所有能力
capabilities = graph.list_capabilities()
print(f"Available capabilities: {capabilities}")

# 检查特定能力
if graph.validate_action("unknown_tool"):
    print("Tool is available")
else:
    print("Tool is NOT available")
```

2. **检查 RuntimeSessionContext**

```python
# 检查 skills
print(f"Available skills: {[s.name for s in context.available_skills]}")

# 检查 MCP servers
print(f"MCP servers: {[s.name for s in context.available_mcp_servers]}")

# 检查连接状态
connected = context.get_connected_mcp_servers()
print(f"Connected MCP servers: {[s.name for s in connected]}")
```

#### 解决方案

确保 action 对应的能力已添加到 RuntimeSessionContext：

```python
context = RuntimeSessionContext(
    # ...
    available_skills=[
        SkillDefinition(
            id="skill_1",
            name="unknown_tool",  # 添加缺失的 skill
            description="...",
        ),
    ],
)
```

---

### 4. 审批钩子未触发

#### 症状

高风险操作直接执行，没有弹出审批对话框。

#### 原因

1. 未配置审批钩子
2. 工具未标记为高风险
3. 审批策略未启用

#### 排查步骤

1. **检查审批钩子**

```python
# 检查是否配置了审批钩子
if executor.approval_hook is None:
    print("No approval hook configured")
```

2. **检查高风险工具列表**

```python
# 检查工具是否在高风险列表中
high_risk_tools = context.runtime_policy.high_risk_tools
print(f"High risk tools: {high_risk_tools}")

if "my_tool" in high_risk_tools:
    print("Tool is marked as high risk")
```

3. **检查审批策略**

```python
# 检查是否启用了审批
if context.runtime_policy.require_approval_for_high_risk:
    print("Approval is enabled")
else:
    print("Approval is DISABLED")
```

#### 解决方案

```python
# 1. 配置审批钩子
async def approval_hook(tool_name: str, params: dict) -> bool:
    print(f"Approval requested for {tool_name}")
    return await show_approval_dialog(tool_name, params)

# 2. 配置高风险工具
runtime_policy = RuntimePolicy(
    require_approval_for_high_risk=True,
    high_risk_tools=["delete_file", "execute_code", "my_tool"],
)

# 3. 创建执行器
executor = UnifiedActionExecutor(
    runtime_context=context,
    approval_hook=approval_hook,
)
```

---

### 5. 审计日志未记录

#### 症状

执行了 actions，但审计日志中没有记录。

#### 原因

1. 未配置 AuditLogger
2. 未调用 flush()
3. 存储后端配置错误

#### 排查步骤

1. **检查 AuditLogger 配置**

```python
# 检查是否配置了 audit logger
if executor.audit_logger is None:
    print("No audit logger configured")
```

2. **检查缓冲区**

```python
# 检查缓冲区大小
buffer_size = len(audit_logger._event_buffer)
print(f"Buffer size: {buffer_size}")

# 手动刷新
await audit_logger.flush()
```

3. **检查存储后端**

```python
# 查询事件
events = await audit_logger.query_events(
    AuditQuery(session_id="session_abc")
)
print(f"Found {len(events)} events")
```

#### 解决方案

```python
# 1. 创建存储
storage = InMemoryAuditStorage()

# 2. 创建 logger
audit_logger = AuditLogger(
    storage=storage,
    batch_size=100,
    flush_interval=5.0,
)

# 3. 启动 logger
await audit_logger.start()

# 4. 配置执行器
executor = UnifiedActionExecutor(
    runtime_context=context,
    audit_logger=audit_logger,
)

# 5. 执行完成后刷新
try:
    result = await executor.execute(action)
finally:
    await audit_logger.stop()  # 自动刷新
```

---

### 6. MCP 服务器连接失败

#### 症状

```
Failed to connect to MCP server 'server_1'
```

#### 原因

1. MCP 服务器未启动
2. 连接配置错误
3. 网络问题

#### 排查步骤

1. **检查 MCP 服务器状态**

```bash
# 检查进程
ps aux | grep mcp-server

# 检查端口
netstat -an | grep 8080
```

2. **检查连接配置**

```python
# 检查服务器配置
server_config = mcp_client._servers.get("server_1")
if server_config:
    print(f"Endpoint: {server_config.endpoint}")
    print(f"Transport: {server_config.transport}")
else:
    print("Server not configured")
```

3. **测试连接**

```python
# 尝试连接
success = await mcp_client.connect("server_1")
if success:
    print("Connected successfully")
else:
    print("Connection failed")

# 检查连接状态
status = mcp_client.get_connection_status("server_1")
print(f"Status: {status}")
```

#### 解决方案

```python
# 1. 确保 MCP 服务器已启动
# (根据具体的 MCP 服务器类型)

# 2. 正确配置服务器
mcp_client.add_server(
    "server_1",
    McpServerConfig(
        server_id="server_1",
        name="File System",
        endpoint="stdio",  # 或 http://localhost:8080
        transport="stdio",  # 或 http
        config={"command": "mcp-server-filesystem"},
    ),
)

# 3. 连接服务器
await mcp_client.connect("server_1")
```

---

### 7. 内存泄漏

#### 症状

内存使用持续增长，最终导致 OOM。

#### 原因

1. 审计日志缓冲区未刷新
2. 能力图未释放
3. 连接未关闭

#### 排查步骤

1. **检查内存使用**

```bash
# 查看进程内存
ps aux | grep python

# 使用 memory_profiler
pip install memory_profiler
python -m memory_profiler script.py
```

2. **检查审计缓冲区**

```python
# 检查缓冲区大小
print(f"Buffer size: {len(audit_logger._event_buffer)}")

# 检查是否启动了自动刷新
print(f"Running: {audit_logger._running}")
```

3. **检查连接**

```python
# 检查 MCP 连接
print(f"Active connections: {len(mcp_client._connections)}")
```

#### 解决方案

```python
# 1. 确保启动 audit logger
await audit_logger.start()

# 2. 使用 context manager
async with audit_logger:
    # 执行操作
    pass

# 3. 正确关闭资源
try:
    # 执行操作
    pass
finally:
    await audit_logger.stop()
    await mcp_client.disconnect_all()
```

---

## 错误信息解析

### RuntimeError: No executor configured

**含义**: act_node 中未配置执行器

**解决**:

```python
# 确保传递了 skill_registry 或 mcp_client
executor = UnifiedActionExecutor(
    runtime_context=context,
    skill_registry=skill_registry,  # 添加这个
)
```

### ValueError: Action requires approval but no approval hook configured

**含义**: 高风险操作需要审批，但未配置审批钩子

**解决**:

```python
# 添加审批钩子
executor = UnifiedActionExecutor(
    runtime_context=context,
    approval_hook=approval_hook,  # 添加这个
)
```

### TimeoutError: Action execution timeout

**含义**: Action 执行超时

**解决**:

```python
# 增加超时时间
runtime_policy = RuntimePolicy(
    timeout_seconds=600,  # 从 300 增加到 600
)
```

### ConnectionError: MCP server disconnected

**含义**: MCP 服务器断开连接

**解决**:

```python
# 重新连接
await mcp_client.connect("server_1")

# 或配置自动重连
runtime_policy = RuntimePolicy(
    mcp_reconnect_enabled=True,
    mcp_reconnect_delay=5,
)
```

---

## 排查步骤

### 通用排查流程

1. **检查日志**

```bash
# 查看应用日志
tail -f /var/log/semibot/runtime.log

# 查看错误日志
tail -f /var/log/semibot/error.log

# 搜索特定错误
grep "ERROR" /var/log/semibot/runtime.log
```

2. **启用调试日志**

```python
import logging

# 设置日志级别
logging.basicConfig(level=logging.DEBUG)

# 或在环境变量中设置
# LOG_LEVEL=DEBUG
```

3. **检查配置**

```python
# 打印配置
print(f"Context: {context}")
print(f"Policy: {context.runtime_policy}")
print(f"Capabilities: {graph.list_capabilities()}")
```

4. **逐步调试**

```python
# 使用 pdb
import pdb; pdb.set_trace()

# 或使用 ipdb
import ipdb; ipdb.set_trace()
```

5. **检查依赖**

```bash
# 检查 Python 版本
python --version

# 检查依赖版本
pip list | grep langgraph
pip list | grep pydantic
```

---

## 调试技巧

### 1. 打印中间状态

```python
# 在关键点打印状态
print(f"State before execution: {state}")
result = await executor.execute(action)
print(f"Result: {result}")
```

### 2. 使用断言

```python
# 验证假设
assert context is not None, "Context should not be None"
assert graph.validate_action("search_web"), "search_web should be available"
```

### 3. 记录详细日志

```python
import logging

logger = logging.getLogger(__name__)

# 记录详细信息
logger.debug(f"Executing action: {action.tool}")
logger.debug(f"Parameters: {action.params}")
logger.debug(f"Capability graph: {graph.list_capabilities()}")
```

### 4. 使用测试工具

```python
# 创建测试上下文
def create_test_context():
    return RuntimeSessionContext(
        org_id="test_org",
        user_id="test_user",
        agent_id="test_agent",
        session_id="test_session",
        agent_config=AgentConfig(
            id="test_agent",
            name="Test Agent",
        ),
    )

# 测试执行
context = create_test_context()
executor = UnifiedActionExecutor(runtime_context=context)
result = await executor.execute(test_action)
```

---

## 性能问题

### 1. Action 执行慢

#### 排查

```python
import time

# 测量执行时间
start = time.time()
result = await executor.execute(action)
duration = time.time() - start
print(f"Execution took {duration:.2f} seconds")
```

#### 优化

```python
# 1. 增加并发
runtime_policy = RuntimePolicy(
    max_concurrent_actions=10,  # 从 5 增加到 10
)

# 2. 减少超时
runtime_policy = RuntimePolicy(
    timeout_seconds=60,  # 从 300 减少到 60
)

# 3. 使用缓存
# (根据具体情况实现)
```

### 2. 审计日志写入慢

#### 排查

```python
# 检查批量大小
print(f"Batch size: {audit_logger.batch_size}")

# 检查刷新间隔
print(f"Flush interval: {audit_logger.flush_interval}")

# 检查缓冲区大小
print(f"Buffer size: {len(audit_logger._event_buffer)}")
```

#### 优化

```python
# 增加批量大小
audit_logger = AuditLogger(
    storage=storage,
    batch_size=2000,  # 从 100 增加到 2000
    flush_interval=15.0,  # 从 5.0 增加到 15.0
)
```

### 3. 能力图构建慢

#### 排查

```python
import time

# 测量构建时间
start = time.time()
graph.build()
duration = time.time() - start
print(f"Build took {duration:.2f} seconds")

# 检查能力数量
print(f"Total capabilities: {len(graph.capabilities)}")
```

#### 优化

```python
# 1. 减少能力数量
# 只添加必需的 skills

# 2. 使用缓存
# (如果能力图不经常变化)

# 3. 懒加载
# 只在需要时构建
```

---

## 联系支持

如果以上方法无法解决问题，请联系技术支持：

### 提供信息

1. **错误信息**
   - 完整的错误堆栈
   - 错误发生的时间
   - 错误发生的频率

2. **环境信息**
   - Python 版本
   - 依赖版本
   - 操作系统

3. **配置信息**
   - RuntimeSessionContext 配置
   - RuntimePolicy 配置
   - 环境变量

4. **日志文件**
   - 应用日志
   - 错误日志
   - 审计日志

### 联系方式

- **GitHub Issues**: https://github.com/your-org/semibot-z3/issues
- **Email**: support@example.com
- **Slack**: #semibot-support

### 提交 Issue 模板

```markdown
## 问题描述

简要描述问题。

## 复现步骤

1. 步骤 1
2. 步骤 2
3. 步骤 3

## 预期行为

描述预期的行为。

## 实际行为

描述实际发生的行为。

## 错误信息

```
粘贴完整的错误堆栈
```

## 环境信息

- Python 版本: 3.11.0
- 操作系统: Ubuntu 20.04
- 依赖版本: (pip list 输出)

## 配置信息

```python
# 粘贴相关配置
```

## 日志

```
粘贴相关日志
```
```

---

## 相关文档

- [API 参考文档](api-reference.md)
- [架构设计文档](architecture.md)
- [部署指南](deployment-guide.md)
- [实施进度总结](implementation-progress.md)
