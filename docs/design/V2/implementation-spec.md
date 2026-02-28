# 事件引擎实现级规范（Implementation Spec）

> 目标：给开发者可直接落地的模块划分、接口签名与最小实现清单。  
> 约束：本地单机、SQLite、复用现有 runtime 机制。

## 1. 模块划分

```
semibot/
  events/
    event_bus.py
    event_store.py
    rules_engine.py
    rule_evaluator.py
    event_router.py
    approval_manager.py
    attention_budget.py
    replay_manager.py
    trigger_scheduler.py
  gateway/
    manager.py
    context_service.py
    policies/
      addressing.py
      proactive.py
      context_retention.py
    adapters/
      base.py
      feishu_adapter.py
      telegram_adapter.py
    notifiers/
      feishu_notifier.py
      telegram_notifier.py
    parsers/
      approval_text.py
    store/
      gateway_store.py
  server/
    api.py                    # 仅 HTTP 路由与请求/响应编解码
    routes/
      gateway.py              # Gateway 相关路由注册（薄路由）
      gateway_schemas.py      # Gateway 路由请求模型（兼容 camel/snake）
```

职责说明：

- `event_bus.py`：进程内发布/订阅与异步分发  
- `event_store.py`：SQLite 写入与查询  
- `rules_engine.py`：规则匹配与治理决策  
- `rule_evaluator.py`：条件表达式解析  
- `event_router.py`：动作路由与执行  
- `approval_manager.py`：审批请求与状态变更  
- `attention_budget.py`：预算与冷却窗口  
- `replay_manager.py`：事件回放  
- `trigger_scheduler.py`：heartbeat/cron 周期事件触发  
- `gateway/manager.py`：统一加载 Gateway 配置并分发到 adapter  
- `gateway/context_service.py`：统一维护 Gateway 主会话、任务运行、最小回写  
- `gateway/adapters/feishu_adapter.py`：飞书入站归一化  
- `gateway/adapters/telegram_adapter.py`：Telegram 入站归一化  
- `gateway/notifiers/*`：provider-specific 出站发送  
- `gateway/parsers/approval_text.py`：跨 Gateway 文本审批解析（同意/拒绝/approve/reject）  
- `gateway/store/gateway_store.py`：Gateway 相关 SQLite 读写  
- `server/routes/gateway.py`：Gateway 路由（HTTP 层）  
- `server/routes/gateway_schemas.py`：Gateway 路由请求模型与 payload 归一化  
- `server/api.py`：应用装配与非 Gateway 路由  

当前状态（2026-02-28）：

- 已完成 `gateway/manager.py` 的第一轮收口：Gateway 配置读写、Feishu/Telegram webhook 入站、审批文本命令解析、出站通知测试、GCS 查询入口均在 manager 层。
- 已完成 `gateway_instances` 多实例化改造：同 provider 支持多实例（多 bot），新增实例级配置 API（create/update/delete/test）。
- 已新增 `server/routes/gateway.py`，把 Gateway 路由从 `server/api.py` 分离，`api.py` 仅做装配与注册。

## 2. 核心接口（签名）

```python
# event_store.py
class EventStore:
    def append(self, event: Event) -> None: ...
    def get(self, event_id: str) -> Event | None: ...
    def exists_idempotency(self, key: str) -> bool: ...
```

```python
# event_bus.py
class EventBus:
    def emit(self, event: Event) -> None: ...
    def subscribe(self, handler: Callable[[Event], Awaitable[None]]) -> None: ...
```

```python
# rules_engine.py
class RulesEngine:
    def __init__(self, store: EventStore, evaluator: RuleEvaluator, router: EventRouter): ...
    async def handle_event(self, event: Event) -> None: ...
```

```python
# event_router.py
class EventRouter:
    async def route(self, event: Event, rule: EventRule) -> None: ...
```

```python
# approval_manager.py
class ApprovalManager:
    async def request(self, approval: ApprovalRequest) -> None: ...
    async def resolve(self, approval_id: str, decision: str) -> None: ...
```

```python
# gateway/context_service.py
class GatewayContextService:
    async def ingest_message(self, provider: str, normalized: dict) -> dict: ...
    async def should_execute(self, provider: str, normalized: dict) -> tuple[bool, str]: ...
    async def create_task_run(self, conversation_id: str, prompt: str, agent_id: str | None = None) -> dict: ...
    async def append_minimal_result(self, run_id: str, final_response: str, metadata: dict) -> None: ...
    async def resolve_text_approval(self, provider: str, normalized: dict) -> dict | None: ...
```

```python
# gateway policy schema (stored in gateway_instances.config_json common area)
class AddressingPolicy(TypedDict):
    mode: Literal["mention_only", "all_messages"]
    allowReplyToBot: bool
    executeOnUnaddressed: bool
    commandPrefixes: list[str]
    sessionContinuationWindowSec: int

class ProactivePolicy(TypedDict):
    mode: Literal["silent", "risk_based", "always"]
    minRiskToNotify: Literal["low", "medium", "high", "critical"]

class ContextPolicy(TypedDict):
    ttlDays: int
    maxRecentMessages: int
    summarizeEveryNMessages: int
```

## 3. 关键伪代码

**RulesEngine.handle_event**

```python
async def handle_event(self, event):
    if event.idempotency_key and self.store.exists_idempotency(event.idempotency_key):
        return

    self.store.append(event)
    rules = self.match_rules(event)
    for rule in rules:
        decision = self.decide(rule, event)
        record_rule_run(...)
        if decision in ("ask", "suggest", "auto"):
            await self.router.route(event, rule)
```

**GatewayContextService.ingest_message（简化）**

```python
async def ingest_message(self, provider, normalized):
    conv = self.get_or_create_conversation(provider=provider, key=normalized["gateway_key"])
    self.append_context_message(conv.id, role="user", content=normalized["text"], metadata=normalized)
    should_execute, reason = await self.should_execute(provider, normalized)
    if not should_execute:
        self.mark_context_metadata(conv.id, addressed=False, address_reason=reason, should_execute=False)
        return {"conversation_id": conv.id, "skipped": True, "reason": reason}
    run = self.create_task_run(conv.id, prompt=normalized["text"], agent_id=normalized.get("agent_id"))
    result = await self.runtime.run_task(
        session_id=run["runtime_session_id"],
        agent_id=run.get("agent_id"),
        task=run["prompt"],
    )
    self.append_minimal_result(run["id"], result["final_response"], {"artifacts": result.get("artifacts", [])})
    return {"conversation_id": conv.id, "run_id": run["id"], "runtime_session_id": run["runtime_session_id"]}
```

**GatewayContextService.should_execute（判定优先级）**

```python
async def should_execute(self, provider, normalized):
    policy = self.get_addressing_policy(provider)
    if normalized.get("is_approval_text"):
        return True, "approval_text"
    if normalized.get("is_mention"):
        return True, "mention"
    if policy.get("allowReplyToBot") and normalized.get("is_reply_to_bot"):
        return True, "reply_to_bot"
    if self.has_command_prefix(normalized.get("text", ""), policy.get("commandPrefixes", [])):
        return True, "command_prefix"
    if policy.get("mode") == "all_messages" and self.in_continuation_window(normalized, policy):
        return True, "continuation_window"
    return False, "not_addressed"
```

## 4. 最小实现清单（MVP）

- EventStore + SQLite 表结构  
- EventBus（进程内订阅）  
- RulesEngine（匹配 + 决策）  
- RuleEvaluator（JSON 条件）  
- EventRouter（notify/run_agent）  
- ApprovalManager（pending/approved/rejected）  
- GatewayContextService（主会话固定 + 任务隔离 + 最小回写）  

## 5. 最小测试清单（MVP）

- 事件写入与幂等  
- 规则匹配与条件判断  
- 冷却窗口与注意力预算  
- ask/suggest/auto 决策路径  
- 审批通过/拒绝  
- Addressing Gate 命中/未命中路径（未命中只注入上下文）  
- `all_messages` 模式下的默认静默行为  

## 6. 与现有 runtime 的对接点

- `BaseAgent.run()` 触发 `agent.lifecycle.*`  
- `UnifiedActionExecutor.execute()` 触发 `tool.exec.*`  
- `AuditLogger` 写入 event_rule_runs 与 approval_requests  
- `Gateway Manager` 统一接入 `/v1/integrations/feishu/*` 与 `/v1/integrations/telegram/*`  
- `GET/PUT /v1/config/gateways/{provider}` 由 runtime SQLite 驱动（非 Postgres）  
- 文本审批解析复用 `gateway/parsers/approval_text.py`，在飞书/Telegram/Webhook 三条入口行为一致  
- Telegram 与飞书都走同一 GatewayContextService，不在 provider adapter 内实现 fork/merge  

## 6.2 新增内建工具契约（2026-02-28）

本轮新增 6 个内建工具，统一通过 `skills/bootstrap.py` 注册，并通过 `RuntimeConfigStore` 的 `tool_configs.config_json` 读取配置：

1. `http_client`
- 能力：通用 REST 调用（GET/POST/PUT/PATCH/DELETE/HEAD）、Bearer/Basic/API Key 鉴权、失败重试。
- 关键参数：`method`、`url/path`、`headers/query/body/json_body`、`auth_*`、`timeout_ms`、`retry_attempts`。
- 默认风控：高风险 + HITL 审批；默认阻断 `localhost/127.0.0.1/::1`，支持域名白/黑名单。

2. `web_fetch`
- 能力：网页抓取与正文抽取；支持 `raw` 与 `readability` 模式，支持提取链接。
- 关键参数：`url`、`mode`、`include_links`、`include_html`、`max_chars`。
- 默认风控：低风险；默认阻断本地回环地址。

3. `json_transform`
- 能力：JSONPath/JMESPath 子集选择器 + mapping 模板 +文本模板渲染。
- 关键参数：`data`、`expression`、`mapping`、`template`、`default_value`。
- 默认风控：低风险。

4. `csv_xlsx`
- 能力：CSV/Excel 读写、过滤、聚合、透视。
- 关键参数：`action`、`path/output_path`、`data`、`filters`、`group_by`、`metrics`、`pivot`。
- 默认风控：高风险 + HITL 审批（涉及本地文件读写）。
- 产物：写入类操作通过 `FileManager` 回传 `generated_files` 元数据。

5. `pdf_report`
- 能力：模板化 PDF 报告生成，支持段落、列表、表格、柱状图、结论段。
- 关键参数：`filename`、`title`、`summary`、`sections`、`conclusion`、`context_data`。
- 默认风控：低风险。
- 产物：生成文件通过 `FileManager` 回传 `generated_files` 元数据。

6. `sql_query_readonly`
- 能力：只读 SQL 查询（仅允许 SELECT/CTE），支持 PostgreSQL/SQLite。
- 关键参数：`query`、`database`、`params`、`timeout_ms`、`max_rows`。
- 默认风控：高风险 + HITL 审批。
- 安全策略：禁止 DML/DDL 关键字；单语句限制；白名单数据库别名；默认行数与超时上限。

## 6.1 现有代码迁移映射（建议）

- `server/feishu.py` -> `gateway/adapters/feishu_adapter.py`
- `server/telegram.py` -> `gateway/adapters/telegram_adapter.py`
- `server/feishu_notifier.py` -> `gateway/notifiers/feishu_notifier.py`
- `server/telegram_notifier.py` -> `gateway/notifiers/telegram_notifier.py`
- `server/approval_text.py` -> `gateway/parsers/approval_text.py`

## 7. 关键配置（环境变量）

- `SEMIBOT_FEISHU_VERIFY_TOKEN`：飞书回调 token 校验（fallback）
- `SEMIBOT_FEISHU_WEBHOOK_URL`：飞书默认出站 webhook（fallback）
- `SEMIBOT_TELEGRAM_BOT_TOKEN`：Telegram bot token（fallback）
- `SEMIBOT_TELEGRAM_DEFAULT_CHAT_ID`：Telegram 默认 chat（fallback）
- 说明：以上环境变量在迁移期仅作为 fallback；长期配置源为 `~/.semibot/semibot.db` 的 `gateway_instances`
