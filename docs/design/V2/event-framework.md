# 事件框架重构建议（Reflex Engine）

> 目标：把当前 hooks/webhooks/heartbeat/cron 等分散触发点统一为事件流，形成可控、可审计、可回放、可扩展的主动式 Agent 平台能力。

## 1. 关键结论

- **统一事件框架是触发层的竞争优势**：相比 OpenClaw 的分散触发点，Semibot 可通过事件总线 + 规则引擎 + 编排执行形成更强的治理能力。
- **主动工作可控化**：事件框架把“主动”拆解为“感知 → 判断 → 询问 → 执行”，避免擅自行动，提升可信度。
- **技能进化天然事件化**：技能进化流程可作为事件驱动的流水线，具备可审计、可回放、可扩展特性。

## 2. 触发层对比（OpenClaw vs Semibot vs Reflex Engine）

| 维度 | OpenClaw（hooks/webhooks/heartbeat/cron） | Semibot 当前 | Semibot 竞争优势架构（Reflex Engine） |
|---|---|---|---|
| Hooks | 生命周期钩子 | 已有 Agent 生命周期钩子 | 统一为 `agent.lifecycle.*` 事件 |
| Webhooks | 外部事件直触发 | 有订阅/日志表 | 统一为 `webhook.*` 事件 + 规则治理 |
| Heartbeat | 保活/健康检查 | WS 心跳 | 统一为 `health.heartbeat.*` 事件 |
| Cron | 定时触发 | VM scheduler | 统一调度器（cron/时区/jitter） |
| 去重/幂等 | 分散 | 局部 | 规则级去重窗口 + 幂等键 |
| 重试/死信 | 分散 | 局部 | 统一重试策略 + DLQ |
| 风险控制 | 分散 | 局部 | 规则级 HITL + 风险分级 |
| 观测/回放 | 低 | 部分 | 事件日志 + 回放能力 |

## 3. 架构概览（Reflex Engine）

```
事件源 (hooks/webhooks/heartbeat/cron/system)
        │
        ▼
  Event Bus / Event Store
        │
        ▼
  Trigger Rules Engine
  (条件/去重/节流/风险/审批)
        │
        ▼
  Orchestrator / Workflow
  (PLAN/ACT/DELEGATE/OBSERVE/REFLECT)
        │
        ▼
  执行 + 审计 + 结果回写
```

## 4. Event Schema（统一事件模型）

```yaml
event:
  event_id: "evt_20260225_0001"
  type: "crm.deal.stale"
  source: "webhook|cron|heartbeat|system|user"
  subject: "deal:12345"
  timestamp: "2026-02-25T10:30:00Z"
  payload: { days_stale: 14, owner: "alice" }
  idempotency_key: "crm.deal.stale:deal:12345:2026-02-25"
  risk_hint: "low|medium|high"
```

## 5. Trigger Rules Schema（规则与治理）

```yaml
rule:
  rule_id: "rule_crm_stale_followup"
  when:
    event_type: "crm.deal.stale"
    conditions:
      - "payload.days_stale >= 14"
  confidence_threshold: 0.65
  attention_budget:
    per_day: 5
    per_rule_cooldown_minutes: 120
  risk_level: "medium"
  action_mode: "ask|suggest|auto"
  dedupe_window_minutes: 600
  priority: 60
```

## 6. 主动工作策略（可控主动）

**阶段拆分**：感知 → 判断 → 询问 → 执行

### 6.1 决策矩阵
- `risk_level=high` → 只能 `ask`
- `confidence < threshold` → 只能 `suggest`
- `attention_budget exceeded` → 暂停或合并
- `dedupe_window 未过` → 不触发

### 6.2 询问模板（最小打扰）
```yaml
ask_template:
  title: "跟进线索提醒"
  summary: "3 个线索超过 14 天未跟进"
  question: "要我自动发送跟进邮件并同步到 CRM 吗？"
  options:
    - "现在执行"
    - "仅生成草稿"
    - "忽略这批"
  required_info:
    - "邮件模板"
```

## 7. 玩法/功能增量（相对 OpenClaw）

- **复合触发**：多个事件联合条件触发（如“异常 + 连续失败”）
- **事件回放/模拟**：基于 event_id 重放执行链路
- **幂等 + 去重窗口**：避免重复触发与重复执行
- **风险分级审批**：高风险走 HITL
- **自动自愈**：heartbeat 异常触发重连/回收/通知
- **事件驱动多 Agent 协作**：Supervisor 拆解 + Worker 执行 + 汇总
- **节流与配额**：成本阈值触发降级
- **窗口聚合**：事件聚合成批处理任务

## 8. 三个非互联网领域示例

- **制造业-设备维护**
  - 事件：`equipment.vibration.anomaly`
  - 询问：“3 号机床振动异常，是否安排停机检修并通知维护班组？”

- **医疗-慢病随访**
  - 事件：`patient.glucose.out_of_range`
  - 询问：“患者本周血糖异常，是否安排随访电话并调整用药建议？”

- **零售-库存预警**
  - 事件：`inventory.low_stock`
  - 询问：“门店 A 的牛奶库存仅够 2 天，是否发起补货并调整陈列？”

## 9. 技能进化事件化

技能进化可作为事件流水线：

1. `skill.exec.success` / `task.completed`
2. `evolution.candidate.created`
3. `evolution.candidate.scored`
4. `evolution.review.requested`
5. `evolution.skill.approved`

**优势**：统一治理、可回放、可审计、可规模化。

## 10. 与现有模块的映射（现状 → 事件化）

- `runtime/src/agents/base.py` 生命周期 hooks → `agent.lifecycle.*` 事件
- `apps/api/src/ws/heartbeat.ts` → `health.heartbeat.*` 事件
- `docs/sql/016_webhooks.sql` → `webhook.*` 事件
- `apps/api/src/scheduler/vm-scheduler.ts` → `cron.*` / `system.vm.*` 事件

## 11. 最小落地路线（MVP）

1. **事件模型 + 事件日志**（event_id/type/source/payload）
2. **规则引擎 MVP**：去重 + 冷却 + 风险分级
3. **HITL 审批接口**：高风险只允许 ask
4. **三类事件接入**：webhook / cron / heartbeat
5. **可观测视图**：事件链路 + 执行结果

---

如需后续细化：
- 事件/规则表结构设计
- Trigger Engine 接口与模块拆分
- 具体 API 设计与迁移计划
