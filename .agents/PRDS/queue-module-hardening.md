# Semibot: Queue 模块加固与完善

**Priority:** High
**Status:** Not Started
**Type:** Improvement
**Created:** 2026-02-06
**Last Updated:** 2026-02-06

## Overview

对 `runtime/src/queue` 模块进行全面加固，解决代码审查中发现的测试覆盖率、硬编码、边界日志、可靠性等问题。

## Description

Queue 模块是基于 Redis 的异步任务队列系统，包含 producer.py 和 consumer.py。当前审查发现以下问题需要修复：

- 测试覆盖率为 0%，无任何测试文件
- 存在多处硬编码值，违反编码规范
- 边界检查缺少日志输出
- 缺少死信队列和重试机制
- 缺少背压控制和队列长度限制
- 监控与可观测性不足

## Implementation Overview

### Phase 1: P0 紧急 - 测试覆盖率

添加完整测试文件，达到 80%+ 覆盖率：

```
runtime/tests/queue/
├── __init__.py
├── test_producer.py      # 生产者单元测试
├── test_consumer.py      # 消费者单元测试
├── test_models.py        # 数据模型测试
└── test_integration.py   # 集成测试
```

**测试用例清单：**

1. 单元测试
   - `TaskPayload.to_dict()` 序列化
   - `TaskMessage.from_dict()` 反序列化
   - Producer 连接/断开
   - Consumer 连接/断开
   - 队列长度获取
   - 队列清空操作

2. 集成测试
   - 完整生产-消费流程
   - 多任务并发处理
   - 结果 Pub/Sub 通知
   - 超时场景处理

3. 异常测试
   - Redis 连接失败恢复
   - 无效 JSON 处理
   - 任务处理器异常
   - 信号中断优雅关闭

### Phase 2: P1 高优先级 - 编码规范修复

#### 2.1 提取硬编码常量

在 `runtime/src/constants/config.py` 中定义：

```python
# Queue 配置常量
DEFAULT_QUEUE_NAME = "agent:tasks"
RESULT_CHANNEL_PREFIX = "agent:results"
MAX_CONCURRENT_TASKS = 10
QUEUE_POLL_TIMEOUT = 30  # 秒
RESULT_WAIT_TIMEOUT = 300  # 秒
ERROR_RETRY_DELAY = 1  # 秒
PUBSUB_MESSAGE_TIMEOUT = 1.0  # 秒
```

#### 2.2 添加边界检查日志

```python
# 并发数达到上限时
if self._semaphore.locked():
    logger.warning(f"[Consumer] 并发数已达上限 (限制: {self.max_concurrent})")

# 队列长度检查
queue_len = await self.get_queue_length()
if queue_len > QUEUE_LENGTH_WARNING_THRESHOLD:
    logger.warning(f"[Producer] 队列积压严重 (当前: {queue_len}, 阈值: {QUEUE_LENGTH_WARNING_THRESHOLD})")
```

### Phase 3: P2 中优先级 - 可靠性增强

#### 3.1 死信队列

```python
DEAD_LETTER_QUEUE = "agent:tasks:dead"
MAX_RETRY_ATTEMPTS = 3

async def move_to_dead_letter(self, task: TaskMessage, error: str):
    """将失败任务移入死信队列"""
    dead_task = {
        **task.to_dict(),
        "error": error,
        "failed_at": datetime.utcnow().isoformat(),
        "retry_count": task.metadata.get("retry_count", 0)
    }
    await self.redis.lpush(DEAD_LETTER_QUEUE, json.dumps(dead_task))
    logger.error(f"[Consumer] 任务移入死信队列 (task_id: {task.task_id}, error: {error})")
```

#### 3.2 指数退避重试

```python
async def _reconnect_with_backoff(self, attempt: int):
    """指数退避重连"""
    delay = min(2 ** attempt, MAX_RECONNECT_DELAY)
    logger.warning(f"[Consumer] 连接失败，{delay}秒后重试 (尝试: {attempt})")
    await asyncio.sleep(delay)
```

#### 3.3 背压控制

```python
MAX_QUEUE_LENGTH = 10000

async def enqueue(self, payload: TaskPayload) -> str:
    queue_len = await self.get_queue_length()
    if queue_len >= MAX_QUEUE_LENGTH:
        logger.error(f"[Producer] 队列已满，拒绝任务 (当前: {queue_len}, 限制: {MAX_QUEUE_LENGTH})")
        raise QueueFullError(f"Queue length exceeded: {queue_len}")
    # ... 继续入队逻辑
```

### Phase 4: P3 低优先级 - 监控增强

添加 Prometheus 指标：

```python
from prometheus_client import Counter, Gauge, Histogram

# 指标定义
queue_length = Gauge('queue_length', 'Current queue length')
tasks_processed = Counter('tasks_processed_total', 'Total tasks processed', ['status'])
task_duration = Histogram('task_duration_seconds', 'Task processing duration')
concurrent_tasks = Gauge('concurrent_tasks', 'Current concurrent tasks')
```

## Features / Requirements

1. **测试覆盖率 ≥ 80%**
   - 单元测试覆盖所有公共方法
   - 集成测试覆盖完整流程
   - 异常场景测试

2. **编码规范合规**
   - 无硬编码常量
   - 边界检查有日志

3. **可靠性增强**
   - 死信队列机制
   - 指数退避重试
   - 背压控制

4. **可观测性**
   - Prometheus 指标
   - 结构化日志

## Files to Create

- `runtime/tests/queue/__init__.py`
- `runtime/tests/queue/test_producer.py`
- `runtime/tests/queue/test_consumer.py`
- `runtime/tests/queue/test_models.py`
- `runtime/tests/queue/test_integration.py`
- `runtime/src/constants/config.py` (如不存在)

## Files to Modify

- `runtime/src/queue/producer.py`
- `runtime/src/queue/consumer.py`
- `runtime/src/queue/__init__.py`

## Testing Requirements

### Unit Tests
- Producer: connect, disconnect, enqueue, wait_for_result, get_queue_length, clear_queue
- Consumer: connect, disconnect, start, stop, _process_task, _publish_result
- Models: TaskPayload.to_dict, TaskMessage.from_dict

### Integration Tests
- 完整生产-消费流程
- 并发任务处理（10个并发）
- Pub/Sub 结果通知
- 超时处理

### Exception Tests
- Redis 连接失败
- JSON 解析错误
- 任务处理器异常
- SIGTERM/SIGINT 信号处理

## Acceptance Criteria

- [ ] 测试覆盖率 ≥ 80%
- [ ] 所有硬编码值提取为常量
- [ ] 边界检查位置有日志输出
- [ ] 死信队列机制实现
- [ ] 指数退避重试实现
- [ ] 背压控制实现
- [ ] Prometheus 指标集成（可选）

## Dependencies

- pytest
- pytest-asyncio
- pytest-cov
- fakeredis (测试用)
- prometheus_client (监控用)

## Risks & Mitigations

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 测试环境需要 Redis | 中 | 使用 fakeredis 模拟 |
| 指标集成可能影响性能 | 低 | 异步采集，不阻塞主流程 |
| 死信队列需要额外处理 | 中 | 提供管理接口查看/重试死信 |
