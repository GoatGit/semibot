# 关键时序（Sequence）

> 目标：固定核心流程时序，作为实现与测试基线。

## 1. 事件触发到执行

1. 事件源产生事件（chat/cron/webhook/system）
2. Event Engine 归一化并写入 `events`
3. Rules Engine 匹配规则并做治理判断
4. 决策 `skip/ask/suggest/auto`
5. `auto` 路由到 `notify/run_agent/execute_plan/...`
6. 写 `event_rule_runs` 与审计日志

### 1.1 调用时序图（核心链路）

```text
EventSource -> EventEngine.publish
EventEngine.publish -> EventStore.append
EventEngine.publish -> RulesEngine.handle_event
RulesEngine.handle_event -> RuleEvaluator.evaluate
RulesEngine.handle_event -> EventStore.insert_rule_run
RulesEngine.handle_event -> EventRouter.route
EventRouter.route -> ActionExecutor.notify/run_agent/execute_plan
ActionExecutor -> AuditLogger.log_action_*
```

## 2. 高风险审批链路

1. 规则判定 `ask` 或 `auto + high risk`
2. 创建 `approval_requests(status=pending)`
3. 推送审批入口（CLI/飞书卡片）
4. 用户批准/拒绝
5. 产生 `approval.approved` 或 `approval.rejected`
6. 重新路由执行或终止

### 2.1 调用时序图（审批）

```text
RulesEngine -> ApprovalManager.request
ApprovalManager.request -> ApprovalStore.insert(pending)
ApprovalManager.request -> Gateway.send_approval_card
UserAction -> Gateway.callback
Gateway.callback -> ApprovalManager.resolve(approved/rejected)
ApprovalManager.resolve -> EventEngine.publish(approval.*)
EventEngine -> RulesEngine.handle_event
```

## 3. 群聊协作链路（飞书优先）

1. 群消息进入 Gateway
2. 转为 `chat.message.received`
3. 规则触发 `run_agent`（Supervisor）
4. Supervisor 拆分给 Worker
5. Worker 结果汇总
6. 群内推送结果卡片

### 3.1 调用时序图（群聊协作）

```text
FeishuGateway -> EventEngine.publish(chat.message.received)
EventEngine -> RulesEngine.handle_event
RulesEngine -> EventRouter.route(run_agent)
EventRouter -> OrchestratorBridge.run_agent(supervisor)
OrchestratorBridge -> WorkerAgents.execute
WorkerAgents -> OrchestratorBridge.aggregate
OrchestratorBridge -> FeishuGateway.send_result_card
```

## 4. 进化闭环链路

1. `task.completed`/`tool.exec.completed`
2. 创建 `evolution.candidate.created`
3. 质量评分 `evolution.candidate.scored`
4. 需要审核则 `evolution.review.requested`
5. 通过后 `evolution.skill.approved`
6. 写入技能库与向量索引
