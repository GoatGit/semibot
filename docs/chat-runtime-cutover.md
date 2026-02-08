# Chat Runtime 切换功能

## 概述

本功能实现了 Chat API 从直接 LLM 调用（`direct_llm`）到 Runtime Orchestrator（`runtime_orchestrator`）的灰度切换，支持自动回退和监控。

## 架构

```
┌─────────────┐
│  Chat API   │
└──────┬──────┘
       │
       ├─ determineExecutionMode()
       │  ├─ 检查自动回退状态
       │  ├─ 检查组织白名单
       │  └─ 返回执行模式
       │
       ├─ direct_llm 模式
       │  └─ handleChatDirect()
       │     └─ 直接调用 LLM Service
       │
       └─ runtime_orchestrator 模式
          └─ handleChatWithRuntime()
             └─ Runtime Adapter
                └─ Python Runtime Service
```

## 配置

### 环境变量

在 `.env` 文件中配置：

```bash
# Chat 执行模式：direct_llm | runtime_orchestrator
CHAT_EXECUTION_MODE="direct_llm"

# Runtime 服务地址
RUNTIME_SERVICE_URL="http://localhost:8000"

# Runtime 灰度白名单（逗号分隔的组织 ID）
CHAT_RUNTIME_ENABLED_ORGS="org-uuid-1,org-uuid-2"

# Runtime 影子流量比例（0-100，用�� A/B 测试）
CHAT_RUNTIME_SHADOW_PERCENT="0"

# Runtime 超时阈值（毫秒，超过此值自动回退）
CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS="300000"

# Runtime 错误率阈值（0-1，超过此值自动回退）
CHAT_RUNTIME_ERROR_RATE_THRESHOLD="0.5"
```

## 灰度策略

### 阶段 1：白名单灰度

1. 设置 `CHAT_EXECUTION_MODE="direct_llm"`（默认模式）
2. 将测试组织 ID 添加到 `CHAT_RUNTIME_ENABLED_ORGS`
3. 这些组织将使用 `runtime_orchestrator` 模式
4. 其他组织继续使用 `direct_llm` 模式

### 阶段 2：全量切换

1. 设置 `CHAT_EXECUTION_MODE="runtime_orchestrator"`
2. 所有组织默认使用 Runtime 模式
3. 保留 `direct_llm` 作为应急回退

## 自动回退机制

系统会自动监控 Runtime 执行指标，在以下情况触发回退：

1. **错误率过高**：错误率 > `CHAT_RUNTIME_ERROR_RATE_THRESHOLD`（默认 50%）
2. **超时率过高**：超时率 > 30%
3. **平均延迟过高**：平均延迟 > 超时阈值的 80%
4. **Runtime 服务不可用**：健康检查失败

触发回退后，所有请求将自动切换到 `direct_llm` 模式，直到指标恢复正常。

## 监控 API

### 获取执行指标

```bash
GET /api/v1/runtime/metrics
Authorization: Bearer <admin-token>
```

响应：

```json
{
  "success": true,
  "data": {
    "direct": {
      "total": 100,
      "success": 98,
      "error": 2,
      "timeout": 0,
      "avgLatencyMs": 1500,
      "errorRate": 0.02,
      "timeoutRate": 0
    },
    "runtime": {
      "total": 50,
      "success": 48,
      "error": 2,
      "timeout": 1,
      "avgLatencyMs": 2000,
      "errorRate": 0.04,
      "timeoutRate": 0.02
    },
    "fallbackEnabled": false,
    "fallbackReason": ""
  }
}
```

### 获取组织指标

```bash
GET /api/v1/runtime/metrics/:orgId
Authorization: Bearer <admin-token>
```

### 获取回退状态

```bash
GET /api/v1/runtime/fallback/status
Authorization: Bearer <admin-token>
```

响应：

```json
{
  "success": true,
  "data": {
    "fallbackEnabled": true,
    "fallbackReason": "错误率过高: 55.00% (阈值: 50.00%)"
  }
}
```

### 手动重置回退

```bash
POST /api/v1/runtime/fallback/reset
Authorization: Bearer <admin-token>
```

## 事件协议

### 兼容事件（保留）

- `message` - Agent2UI 消息
- `error` - 错误事件
- `done` - 完成事件
- `heartbeat` - 心跳事件

### 新增事件（Runtime 模式）

- `plan_step` - 计划步骤更新
- `skill_call` - Skill 调用
- `skill_result` - Skill 结果
- `mcp_call` - MCP 工具调用
- `mcp_result` - MCP 工具结果

### 事件示例

#### plan_step 事件

```json
{
  "event": "message",
  "data": {
    "id": "msg-uuid",
    "type": "plan_step",
    "data": {
      "stepId": "step-1",
      "title": "搜索相关信息",
      "status": "running",
      "tool": "web_search",
      "params": { "query": "..." }
    },
    "timestamp": "2024-01-01T00:00:00Z"
  }
}
```

#### skill_call 事件

```json
{
  "event": "message",
  "data": {
    "id": "msg-uuid",
    "type": "skill_call",
    "data": {
      "skillId": "skill-uuid",
      "skillName": "web_search",
      "arguments": { "query": "..." },
      "status": "calling"
    },
    "timestamp": "2024-01-01T00:00:00Z"
  }
}
```

## 测试

### 单元测试

```bash
cd apps/api
npm test src/__tests__/runtime.adapter.test.ts
```

### 集成测试

```bash
cd apps/api
npm test src/__tests__/chat-runtime.integration.test.ts
```

### 手动测试

1. 启动 Runtime 服务：

```bash
cd runtime
python -m uvicorn src.main:app --reload --port 8000
```

2. 启动 API 服务：

```bash
cd apps/api
npm run dev
```

3. 发送测试请求：

```bash
curl -X POST http://localhost:3001/api/v1/chat/start \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "agent-uuid",
    "message": "Hello"
  }'
```

## 故障排查

### Runtime 服务不可用

**症状**：所有请求自动回退到 `direct_llm` 模式

**排查步骤**：

1. 检查 Runtime 服务是否运行：`curl http://localhost:8000/health`
2. 检查 `RUNTIME_SERVICE_URL` 配置是否正确
3. 查看 API 日志：`[RuntimeAdapter] 健康检查失败`

### 自动回退触发

**症状**：日志显示 `[Chat] 自动回退到 direct 模式`

**排查步骤**：

1. 查看回退原因：`GET /api/v1/runtime/fallback/status`
2. 查看执行指标：`GET /api/v1/runtime/metrics`
3. 根据回退原因修复问题
4. 手动重置回退：`POST /api/v1/runtime/fallback/reset`

### 事件未正确显示

**症状**：前端无法显示新事件类型

**排查步骤**：

1. 确认前端已更新 `@semibot/shared-types` 包
2. 检查前端是否实现了新事件类型的渲染组件
3. 查看浏览器控制台是否有类型错误

## 回滚计划

如果需要紧急回滚到 `direct_llm` 模式：

1. **方法 1：环境变量**（推荐）

```bash
# 修改 .env
CHAT_EXECUTION_MODE="direct_llm"
CHAT_RUNTIME_ENABLED_ORGS=""

# 重启服务
pm2 restart api
```

2. **方法 2：手动触发回退**

```bash
# 触发自动回退（不需要重启）
POST /api/v1/runtime/fallback/reset
```

3. **方法 3：代码回滚**

```bash
git revert <commit-hash>
git push
# 部署
```

## 性能基线

| 指标 | direct_llm | runtime_orchestrator | 目标 |
|------|------------|----------------------|------|
| 平均延迟 | 1.5s | 2.0s | < 3s |
| P95 延迟 | 3s | 4s | < 5s |
| 错误率 | 2% | 4% | < 5% |
| 超时率 | 0.5% | 1% | < 2% |

## 相关文档

- [PRD: Chat 主流程切换到 Runtime](./.agents/PRDS/chat-cutover-to-runtime.md)
- [Task: Chat 切换任务](./.agents/TASKS/chat-cutover-to-runtime.md)
- [Runtime Orchestrator 文档](./runtime/README.md)
