## Task: Queue 模块加固与完善

**ID:** queue-module-hardening
**Label:** Semibot: Queue 模块加固与完善
**Description:** 解决 queue 模块测试覆盖率、硬编码、边界日志、可靠性等问题
**Type:** Improvement
**Status:** In Progress
**Priority:** High
**Created:** 2026-02-06
**Updated:** 2026-02-06
**PRD:** [Link](../PRDS/queue-module-hardening.md)

---

## 子任务列表

### P0 - 紧急（测试覆盖率）

- [ ] **TASK-Q001**: 创建测试目录结构 `runtime/tests/queue/`
- [ ] **TASK-Q002**: 编写 `test_models.py` - TaskPayload/TaskMessage 序列化测试
- [ ] **TASK-Q003**: 编写 `test_producer.py` - Producer 单元测试
  - [ ] connect/disconnect
  - [ ] enqueue
  - [ ] wait_for_result
  - [ ] get_queue_length
  - [ ] clear_queue
- [ ] **TASK-Q004**: 编写 `test_consumer.py` - Consumer 单元测试
  - [ ] connect/disconnect
  - [ ] start/stop
  - [ ] _process_task
  - [ ] _publish_result
- [ ] **TASK-Q005**: 编写 `test_integration.py` - 集成测试
  - [ ] 完整生产-消费流程
  - [ ] 并发任务处理
  - [ ] Pub/Sub 结果通知
- [ ] **TASK-Q006**: 编写异常测试用例
  - [ ] Redis 连接失败
  - [ ] JSON 解析错误
  - [ ] 任务处理器异常
  - [ ] 信号中断处理
- [ ] **TASK-Q007**: 验证测试覆盖率 ≥ 80%

### P1 - 高优先级（编码规范）

- [ ] **TASK-Q008**: 创建/更新 `runtime/src/constants/config.py`
  - [ ] DEFAULT_QUEUE_NAME
  - [ ] RESULT_CHANNEL_PREFIX
  - [ ] MAX_CONCURRENT_TASKS
  - [ ] QUEUE_POLL_TIMEOUT
  - [ ] RESULT_WAIT_TIMEOUT
  - [ ] ERROR_RETRY_DELAY
  - [ ] PUBSUB_MESSAGE_TIMEOUT
- [ ] **TASK-Q009**: 修改 `producer.py` 使用常量替换硬编码值
- [ ] **TASK-Q010**: 修改 `consumer.py` 使用常量替换硬编码值
- [ ] **TASK-Q011**: 添加并发数达到上限的日志
- [ ] **TASK-Q012**: 添加队列长度边界检查日志

### P2 - 中优先级（可靠性增强）

- [ ] **TASK-Q013**: 实现死信队列机制
  - [ ] 定义 DEAD_LETTER_QUEUE 常量
  - [ ] 实现 move_to_dead_letter 方法
  - [ ] 失败任务自动移入死信队列
- [ ] **TASK-Q014**: 实现指数退避重试
  - [ ] 连接失败时指数退避
  - [ ] 最大重试次数限制
- [ ] **TASK-Q015**: 实现背压控制
  - [ ] 定义 MAX_QUEUE_LENGTH 常量
  - [ ] 队列满时拒绝入队
  - [ ] 抛出 QueueFullError 异常
- [ ] **TASK-Q016**: 添加任务重试机制
  - [ ] retry_count 字段
  - [ ] MAX_RETRY_ATTEMPTS 常量
  - [ ] 重试逻辑实现

### P3 - 低优先级（监控增强）

- [ ] **TASK-Q017**: 集成 Prometheus 指标
  - [ ] queue_length Gauge
  - [ ] tasks_processed Counter
  - [ ] task_duration Histogram
  - [ ] concurrent_tasks Gauge
- [ ] **TASK-Q018**: 添加死信队列管理接口
  - [ ] 查看死信列表
  - [ ] 重试死信任务
  - [ ] 清空死信队列

---

## 验收标准

| 检查项 | 状态 |
|--------|------|
| 测试覆盖率 ≥ 80% | ⬜ |
| 无硬编码常量 | ⬜ |
| 边界检查有日志 | ⬜ |
| 死信队列实现 | ⬜ |
| 指数退避重试 | ⬜ |
| 背压控制实现 | ⬜ |
| Prometheus 指标（可选） | ⬜ |

---

## 相关文件

**需创建：**
- `runtime/tests/queue/__init__.py`
- `runtime/tests/queue/test_producer.py`
- `runtime/tests/queue/test_consumer.py`
- `runtime/tests/queue/test_models.py`
- `runtime/tests/queue/test_integration.py`

**需修改：**
- `runtime/src/queue/producer.py`
- `runtime/src/queue/consumer.py`
- `runtime/src/constants/config.py`
