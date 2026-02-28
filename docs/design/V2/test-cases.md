# 测试用例模板（事件引擎）

> 目标：把关键行为转成可自动化验证的测试清单。

## 1. 单元测试

### 1.1 `RuleEvaluator`

- 条件 `all/any/not` 正确计算
- 支持操作符 `== != > >= < <= in contains exists`
- 非法表达式返回可解释错误

### 1.2 `AttentionBudget`

- 当日额度未达上限可放行
- 达上限返回 `skip`
- 跨天后额度重置

### 1.3 `EventStore`

- `idempotency_key` 冲突被识别
- `events` 查询支持 `type/since/limit`

## 2. 集成测试

### 2.1 事件到动作

- 输入 `tool.exec.failed` 事件
- 命中规则 `suggest + notify`
- 断言写入 `event_rule_runs`
- 断言通知动作被调用

### 2.2 高风险审批

- 输入 high risk 事件
- 断言创建 `approval_requests(pending)`
- 模拟 approve
- 断言动作执行

### 2.3 回放幂等

- 首次处理事件成功
- 重放同 `idempotency_key` 事件
- 断言不会重复执行动作

### 2.4 单次任务执行 API

- 调用 `POST /v1/tasks/run`
- 任务参数进入本地编排执行
- 返回 `status/final_response/tool_results`，可用于 CLI/Web 前台直接消费

### 2.5 聊天 API（流式与非流式）

- 调用 `POST /v1/chat`（`stream=false`）返回最终响应
- 调用 `POST /v1/chat`（`stream=true`）返回 SSE 事件流
- 断言事件流含 `start` 与 `done`

## 3. 端到端测试

### 3.1 飞书审批链路

- 群消息触发任务
- 生成审批卡片
- 卡片回传 approve
- 落地 `approval.action` + `chat.card.action` 事件
- 群内收到结果卡片

### 3.2 进化闭环

- `task.completed` 连续成功
- 产生 `evolution.candidate.created`
- 通过审核后写入技能库

### 3.3 研究报告生成（任务验收）

- 输入任务：研究阿里巴巴股票并生成 PDF 报告
- 执行链路：检索结果上下文 -> `pdf` 工具 -> 产出文件
- 断言：PDF 文件落地且大小 > 0，元数据可追踪

## 4. 测试数据夹具

- `fixtures/events.json`
- `fixtures/rules.json`
- `fixtures/approvals.json`

## 5. CI 通过标准

- 单元测试通过率 100%
- 集成测试通过率 100%
- E2E 关键链路（审批、回放）必须通过

## 6. 当前测试分层说明（V2）

- `runtime/tests/e2e/test_agent_flow.py`：事件 -> 规则 -> 动作主链路（含 cursor/resume）。
- `runtime/tests/e2e/test_complete_workflow.py`：群聊协作 + 高风险审批完整闭环。
- `runtime/tests/e2e/test_full_agent_workflow.py`：heartbeat/cron 与飞书回调边界。
- `runtime/tests/e2e/test_v2_event_workflow.py`：飞书消息、审批回传、Dashboard 实时流。
- `runtime/tests/e2e/test_stock_research_pdf_task.py`：研究任务到 PDF 文件产出的闭环。

## 7. CI 门禁分组（已落地）

- Core：`tests/events + tests/server + session/agents/orchestrator 关键用例`
- E2E-Collab：`pytest tests/e2e -m "e2e and e2e_collab"`
- E2E-Approval：`pytest tests/e2e -m "e2e and e2e_approval"`
- E2E-Scheduler：`pytest tests/e2e -m "e2e and e2e_scheduler"`
- E2E-Dashboard：`pytest tests/e2e -m "e2e and e2e_dashboard"`
- E2E-Research：`pytest tests/e2e -m "e2e and e2e_research"`

对应 CI 文件：`.github/workflows/test.yml`
