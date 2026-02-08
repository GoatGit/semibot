# Runtime 观测与运维

## 关键指标 Dashboard

### 1. 成功率监控

```yaml
# Grafana Dashboard 配置示例
panels:
  - title: "Chat 执行成功率"
    type: graph
    targets:
      - expr: |
          sum(rate(chat_execution_success_total[5m])) by (mode) /
          sum(rate(chat_execution_total[5m])) by (mode) * 100
    legend:
      - direct_llm
      - runtime_orchestrator
    thresholds:
      - value: 95
        color: green
      - value: 90
        color: yellow
      - value: 0
        color: red
```

### 2. 延迟监控

```yaml
  - title: "Chat 执行延迟 (P50/P95/P99)"
    type: graph
    targets:
      - expr: histogram_quantile(0.50, chat_execution_latency_ms)
        legend: P50
      - expr: histogram_quantile(0.95, chat_execution_latency_ms)
        legend: P95
      - expr: histogram_quantile(0.99, chat_execution_latency_ms)
        legend: P99
    thresholds:
      - value: 3000
        color: green
      - value: 5000
        color: yellow
      - value: 10000
        color: red
```

### 3. 回退状态监控

```yaml
  - title: "自动回退状态"
    type: stat
    targets:
      - expr: chat_runtime_fallback_enabled
    mappings:
      - value: 0
        text: "正常"
        color: green
      - value: 1
        text: "已回退"
        color: red
```

### 4. 错误率监控

```yaml
  - title: "错误率趋势"
    type: graph
    targets:
      - expr: |
          sum(rate(chat_execution_error_total[5m])) by (mode) /
          sum(rate(chat_execution_total[5m])) by (mode) * 100
    alert:
      condition: value > 5
      message: "Chat 错误率超过 5%"
```

## 日志查询

### 查看 Runtime 执行日志

```bash
# 查看最近的 Runtime 执行
grep "RuntimeAdapter" /var/log/semibot/api.log | tail -100

# 查看失败的执行
grep "RuntimeAdapter.*失败" /var/log/semibot/api.log

# 查看自动回退触发
grep "自动回退" /var/log/semibot/api.log
```

### 查看监控指标

```bash
# 查看当前指标
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/api/v1/runtime/metrics

# 查看回退状态
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  http://localhost:3001/api/v1/runtime/fallback/status
```

## 告警规则

### 1. Runtime 服务不可用

```yaml
alert: RuntimeServiceDown
expr: up{job="runtime-service"} == 0
for: 1m
labels:
  severity: critical
annotations:
  summary: "Runtime 服务不可用"
  description: "Runtime 服务已停止响应超过 1 分钟"
```

### 2. 错误率过高

```yaml
alert: HighErrorRate
expr: |
  sum(rate(chat_execution_error_total{mode="runtime_orchestrator"}[5m])) /
  sum(rate(chat_execution_total{mode="runtime_orchestrator"}[5m])) > 0.1
for: 5m
labels:
  severity: warning
annotations:
  summary: "Runtime 错误率过高"
  description: "Runtime 模式错误率超过 10%，持续 5 分钟"
```

### 3. 延迟过高

```yaml
alert: HighLatency
expr: |
  histogram_quantile(0.95,
    chat_execution_latency_ms{mode="runtime_orchestrator"}
  ) > 5000
for: 5m
labels:
  severity: warning
annotations:
  summary: "Runtime 延迟过高"
  description: "Runtime 模式 P95 延迟超过 5 秒"
```

### 4. 自动回退触发

```yaml
alert: AutoFallbackTriggered
expr: chat_runtime_fallback_enabled == 1
for: 1m
labels:
  severity: warning
annotations:
  summary: "Runtime 自动回退已触发"
  description: "系统已自动回退到 direct_llm 模式"
```

## Runbook - 故障处理流程

### 场景 1：Runtime 服务不可用

**症状**：
- 告警：`RuntimeServiceDown`
- 日志：`[RuntimeAdapter] 健康检查失败`
- 所有请求自动回退到 `direct_llm`

**处理步骤**：

1. **确认服务状态**
   ```bash
   # 检查 Runtime 服务
   curl http://localhost:8000/health

   # 检查进程
   ps aux | grep uvicorn
   ```

2. **查看 Runtime 日志**
   ```bash
   tail -100 /var/log/semibot/runtime.log
   ```

3. **重启服务**
   ```bash
   # 使用 systemd
   sudo systemctl restart semibot-runtime

   # 或使用 pm2
   pm2 restart runtime
   ```

4. **验证恢复**
   ```bash
   curl http://localhost:8000/health
   ```

5. **重置回退状态**（如果需要���
   ```bash
   curl -X POST \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:3001/api/v1/runtime/fallback/reset
   ```

### ��景 2：错误率突然升高

**症状**：
- 告警：`HighErrorRate`
- 日志：大量 `[Chat] Runtime 执行失败`
- 可能触发自动回退

**处理步骤**：

1. **查看错误详情**
   ```bash
   # 查看最近的错误
   grep "Runtime 执行失败" /var/log/semibot/api.log | tail -50

   # 统计错误类型
   grep "Runtime 执行失败" /var/log/semibot/api.log | \
     awk -F'错误:' '{print $2}' | sort | uniq -c | sort -rn
   ```

2. **检查 Runtime 资源**
   ```bash
   # CPU 和内存使用
   top -p $(pgrep -f uvicorn)

   # 磁盘空间
   df -h
   ```

3. **检查依赖服务**
   ```bash
   # 数据库连接
   psql -h localhost -U semibot -c "SELECT 1"

   # Redis 连接
   redis-cli ping
   ```

4. **根据错误类型处理**
   - **超时错误**：增加 `RUNTIME_EXECUTION_TIMEOUT_MS`
   - **内存错误**：增加 Runtime 服务内存限制
   - **依赖错误**：修复依赖服务问题

5. **监控恢复**
   ```bash
   # 查看实时指标
   watch -n 5 'curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:3001/api/v1/runtime/metrics | jq .data.runtime'
   ```

### 场景 3：延迟突然升高

**症状**：
- 告警：`HighLatency`
- 用户反馈响应慢
- P95 延迟 > 5 秒

**处理步骤**：

1. **查看延迟分布**
   ```bash
   # 查看最近的执行时间
   grep "执行完成.*耗时" /var/log/semibot/api.log | \
     awk -F'耗时: ' '{print $2}' | \
     awk -F'ms' '{print $1}' | \
     sort -n | tail -20
   ```

2. **检查系统负载**
   ```bash
   # 系统负载
   uptime

   # IO 等待
   iostat -x 1 5
   ```

3. **检查数据库性能**
   ```bash
   # 慢查询
   psql -h localhost -U semibot -c \
     "SELECT query, calls, mean_exec_time
      FROM pg_stat_statements
      ORDER BY mean_exec_time DESC
      LIMIT 10"
   ```

4. **优化措施**
   - 增加 Runtime 服务实例数
   - 优化数据库查询
   - 增加缓存
   - 调整超时阈值

### 场景 4：自动回退频繁触发

**症状**：
- 告警：`AutoFallbackTriggered`
- 回退状态频繁变化
- 服务不稳定

**处理步骤**：

1. **查看回退历史**
   ```bash
   grep "触发自动回退\|禁用自动回退" /var/log/semibot/api.log | tail -20
   ```

2. **分析根本原因**
   ```bash
   # 查看回退原因
   curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
     http://localhost:3001/api/v1/runtime/fallback/status | \
     jq .data.fallbackReason
   ```

3. **调整阈值**（如果阈值过于敏感）
   ```bash
   # 修改 .env
   CHAT_RUNTIME_ERROR_RATE_THRESHOLD="0.7"  # 从 0.5 提高到 0.7

   # 重启服务
   pm2 restart api
   ```

4. **修复根本问题**
   - 根据回退原因修复 Runtime 服务问题
   - 优化性能
   - 增加资源

5. **暂时禁用 Runtime**（如果问题严重）
   ```bash
   # 修改 .env
   CHAT_EXECUTION_MODE="direct_llm"
   CHAT_RUNTIME_ENABLED_ORGS=""

   # 重启服务
   pm2 restart api
   ```

## 性能优化建议

### 1. Runtime 服务优化

- **增加工作进程数**
  ```bash
  uvicorn src.main:app --workers 4
  ```

- **启用 HTTP/2**
  ```bash
  uvicorn src.main:app --http h2
  ```

- **调整超时配置**
  ```python
  # runtime/src/constants/config.py
  EXECUTION_TIMEOUT_MS = 300000  # 5 分钟
  ```

### 2. API 服务优化

- **增加连接池大小**
  ```typescript
  // apps/api/src/constants/config.ts
  export const REDIS_POOL_SIZE = 20  // 从 10 增加到 20
  export const DB_POOL_MAX = 20      // 从 10 增加到 20
  ```

- **启用响应缓存**
  ```typescript
  // 缓存 Runtime 健康检查结果
  const healthCheckCache = new Map()
  ```

### 3. 数据库优化

- **添加索引**
  ```sql
  CREATE INDEX idx_sessions_org_id ON sessions(org_id);
  CREATE INDEX idx_messages_session_id ON messages(session_id);
  ```

- **定期清理旧数据**
  ```sql
  DELETE FROM messages
  WHERE created_at < NOW() - INTERVAL '30 days';
  ```

## 容量规划

### 当前容量

- **API 服务**：2 核 4GB，可处理 100 并发请求
- **Runtime 服务**：4 核 8GB，可处理 50 并发执行
- **数据库**：4 核 16GB，可支持 1000 TPS

### 扩容建议

当满足以下条件时考虑扩容：

1. **CPU 使用率** > 70%（持续 5 分钟）
2. **内存使用率** > 80%
3. **P95 延迟** > 5 秒
4. **错误率** > 5%

扩容方案：

- **水平扩展**：增加 Runtime 服务实例
- **垂直扩展**：增加单实例资源
- **数据库优化**：读写分离、分片

## 相关链接

- [Chat Runtime 切换文档](./chat-runtime-cutover.md)
- [监控 API 文档](../apps/api/src/routes/v1/runtime.ts)
- [Runtime Adapter 实现](../apps/api/src/adapters/runtime.adapter.ts)
