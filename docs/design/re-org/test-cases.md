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

## 3. 端到端测试

### 3.1 飞书审批链路

- 群消息触发任务
- 生成审批卡片
- 卡片回传 approve
- 群内收到结果卡片

### 3.2 进化闭环

- `task.completed` 连续成功
- 产生 `evolution.candidate.created`
- 通过审核后写入技能库

## 4. 测试数据夹具

- `fixtures/events.json`
- `fixtures/rules.json`
- `fixtures/approvals.json`

## 5. CI 通过标准

- 单元测试通过率 100%
- 集成测试通过率 100%
- E2E 关键链路（审批、回放）必须通过

