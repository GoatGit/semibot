# Chat Runtime 切换 - 验证清单

## 代码验证

### ✅ 文件创建验证

- [x] `apps/api/src/adapters/runtime.adapter.ts` - Runtime 适配器
- [x] `apps/api/src/services/runtime-monitor.service.ts` - 监控服务
- [x] `apps/api/src/routes/v1/runtime.ts` - 监控 API 路由
- [x] `apps/api/src/__tests__/runtime.adapter.test.ts` - 单元测试
- [x] `apps/api/src/__tests__/chat-runtime.integration.test.ts` - 集成测试
- [x] `docs/chat-runtime-cutover.md` - 功能文档
- [x] `docs/runtime-observability.md` - 观测文档
- [x] `docs/chat-runtime-implementation-summary.md` - 实施总结

### ✅ 文件修改验证

- [x] `apps/api/src/constants/config.ts` - 添加 Runtime 配置
- [x] `apps/api/src/services/chat.service.ts` - 实现双模式支持
- [x] `apps/api/src/routes/v1/index.ts` - 注册 Runtime 路由
- [x] `packages/shared-types/src/agent2ui.ts` - 扩展事件类型
- [x] `.env.example` - 添加配置示例

## 功能验证

### 1. 配置验证

```bash
# 检查环境变量配置
grep -E "CHAT_|RUNTIME_" .env.example

# 预期输出：
# CHAT_EXECUTION_MODE="direct_llm"
# RUNTIME_SERVICE_URL="http://localhost:8801"
# CHAT_RUNTIME_ENABLED_ORGS=""
# CHAT_RUNTIME_SHADOW_PERCENT="0"
# CHAT_RUNTIME_TIMEOUT_THRESHOLD_MS="300000"
# CHAT_RUNTIME_ERROR_RATE_THRESHOLD="0.5"
```

### 2. 类型定义验证

```bash
# 检查 Agent2UI 类型扩展
grep -A 5 "plan_step\|skill_call\|mcp_call" packages/shared-types/src/agent2ui.ts

# 预期输出：包含新的事件类型定义
```

### 3. 路由注册验证

```bash
# 检查路由注册
grep "runtimeRouter" apps/api/src/routes/v1/index.ts

# 预期输出：
# import runtimeRouter from './runtime'
# router.use('/runtime', runtimeRouter)
```

### 4. 监控服务验证

```bash
# 检查监控服务导出
grep "export.*getRuntimeMonitor" apps/api/src/services/runtime-monitor.service.ts

# 预期输出：
# export function getRuntimeMonitor(): RuntimeMonitorService
```

## 编译验证

### TypeScript 编译

```bash
cd apps/api
npm install
npm run build

# 预期：编译成功，无错误
```

### 类型检查

```bash
cd packages/shared-types
npm install
npm run build

# 预期：编译成功，无错误
```

## 测试验证

### 单元测试

```bash
cd apps/api
npm test src/__tests__/runtime.adapter.test.ts

# 预期：所有测试通过
```

### 集成测试

```bash
cd apps/api
npm test src/__tests__/chat-ws.integration.test.ts

# 预期：所有测试通过（部分测试可能需要实际环境）
```

## 运行时验证

### 1. 启动服务

```bash
# 终端 1：启动 Runtime 服务
cd runtime
python -m src.main

# 终端 2：启动 API 服务
cd apps/api
npm run dev
```

### 2. 健康检查

```bash
# 检查 API 服务
curl http://localhost:3001/api/v1/health
# 预期：{"success": true, "data": {...}}
```

### 3. Chat API 测试

```bash
# 测试 direct_llm 模式（默认）
curl -X POST http://localhost:3001/api/v1/chat/start \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test-agent-id",
    "message": "Hello"
  }'

# 预期：返回 SSE 流，包含 message 和 done 事件
```

### 4. 灰度切换测试

```bash
# 1. 设置白名单
export CHAT_RUNTIME_ENABLED_ORGS="test-org-id"

# 2. 重启 API 服务
pm2 restart api

# 3. 使用白名单组织的 token 测试
curl -X POST http://localhost:3001/api/v1/chat/start \
  -H "Authorization: Bearer $WHITELIST_ORG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test-agent-id",
    "message": "Hello"
  }'

# 预期：使用 runtime_orchestrator 模式，done 事件包含 "executionMode": "runtime_orchestrator"
```

### 5. 自动回退测试

```bash
# 1. 停止 Runtime 服务
# Ctrl+C 停止 python -m src.main

# 2. 发送请求
curl -X POST http://localhost:3001/api/v1/chat/start \
  -H "Authorization: Bearer $WHITELIST_ORG_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "test-agent-id",
    "message": "Hello"
  }'

# 预期：自动回退到 direct_llm 模式，done 事件包含 "executionMode": "direct_llm"
```

## 性能验证

### 1. 延迟测试

```bash
# 使用 Apache Bench 测试
ab -n 100 -c 10 \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -p chat-request.json \
  http://localhost:3001/api/v1/chat/start

# 预期：
# - direct_llm 模式：平均延迟 < 2s
# - runtime_orchestrator 模式：平均延迟 < 3s
```

### 2. 并发测试

```bash
# 使用 wrk 测试
wrk -t 4 -c 20 -d 30s \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -s chat-request.lua \
  http://localhost:3001/api/v1/chat/start

# 预期：
# - 错误率 < 5%
# - P95 延迟 < 5s
```

## 监控验证

### 1. 日志验证

```bash
# 查看 Runtime 相关日志
tail -f logs/api.log | grep -E "ws|vm|Chat.*执行模式"

# 预期输出示例：
# [Chat] 执行模式: direct_llm - Session: xxx, Org: xxx
# [Chat] ws dispatch - Session: xxx, VM: xxx
```

### 2. 指标验证

```bash
# 定期查看指标
watch -n 5 'curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/api/v1/runtime/metrics | jq .data'

# 预期：实时更新的指标数据
```

## 文档验证

### 1. 文档完整性

- [x] 功能文档包含架构说明
- [x] 功能文档包含配置指南
- [x] 功能文档包含灰度策略
- [x] 功能文档包含故障排查
- [x] 观测文档包含 Dashboard 配置
- [x] 观测文档包含告警规则
- [x] 观测文档包含 Runbook

### 2. 代码注释

```bash
# 检查关键函数的注释
grep -B 2 "export.*function" apps/api/src/adapters/runtime.adapter.ts | head -20

# 预期：每个导出函数都有 JSDoc 注释
```

## 验证结果

### 通过标准

- [ ] 所有文件创建成功
- [ ] TypeScript 编译无错误
- [ ] 单元测试全部通过
- [ ] 集成测试全部通过
- [ ] 服务可以正常启动
- [ ] 健康检查通过
- [ ] Chat API 正常工作
- [ ] 灰度切换正常
- [ ] 自动回退正常
- [ ] 监控 API 正常
- [ ] 性能符合预期
- [ ] 文档完整准确

### 已知问题

1. **TypeScript 编译**
   - 需要安装依赖：`npm install`
   - 需要构建 shared-types：`cd packages/shared-types && npm run build`

2. **测试执行**
   - 部分集成测试需要完整的测试环境（数据库、认证）
   - 可以先跳过，在实际环境中验证

3. **Runtime 服务**
   - 需要确保 Python Runtime 服务正常运行
   - 需要配置正确的 `RUNTIME_SERVICE_URL`

## 下一步

1. **安装依赖并编译**
   ```bash
   cd packages/shared-types && npm install && npm run build
   cd ../../apps/api && npm install && npm run build
   ```

2. **运行测试**
   ```bash
   cd apps/api
   npm test
   ```

3. **启动服务并验证**
   ```bash
   # 按照"运行时验证"部分的步骤执行
   ```

4. **部署到测试环境**
   ```bash
   # 按照实施总结中的部署步骤执行
   ```

## 联系方式

如有问题，请联系：
- 开发团队：dev@semibot.ai
- 运维团队：ops@semibot.ai
