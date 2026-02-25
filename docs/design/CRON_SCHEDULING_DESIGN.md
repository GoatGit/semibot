# Cron 调度能力设计（Control Plane 驱动）

## 1. 目标与结论

### 1.1 目标

为 Semibot 增加 OpenClaw 风格的自动化调度能力，使 Agent 不仅可被动对话触发，还可主动按计划执行任务（如日报、巡检、数据同步、告警分析）。

### 1.2 核心结论

- `Cron 能力放在控制层（Control Plane）`，执行层只负责被触发后的任务执行。
- 前端采用 `独立页面为主 + 聊天流程内快捷入口为辅`：
  - 独立页面负责完整生命周期管理（创建、启停、日志、失败重跑、权限与审计）。
  - 聊天页面仅提供“将当前对话转成定时任务”的快捷创建，不承载复杂运维功能。

---

## 2. 为什么放控制层

- 调度是长期状态机（时区、去重、重试、补偿），执行层是短生命周期连接，不适合做权威调度源。
- 调度涉及多租户权限、审计、配额、SLA，天然属于控制层职责。
- 控制层可统一对接 UI/API/审计；执行层保持无状态、可替换（semigraph/openclaw）。

---

## 3. 总体架构

## 3.1 组件

- `Scheduler Service（API 内）`
  - 解析 cron/interval/at
  - 维护 next_run_at
  - 任务触发与重试编排
- `Schedule Dispatcher（API 内）`
  - 将一次调度转换为执行请求（start_session + user_message）
  - 写入 run 记录与状态回传
- `Execution Plane（runtime）`
  - 接收调度触发消息，执行 Agent 流程
  - 回传结果事件（success/failed/timeout）
- `Web UI`
  - 调度管理页
  - 聊天页快捷创建入口

## 3.2 触发链路

1. 用户创建 schedule（cron/interval/once）。
2. Scheduler 到期扫描，生成 `job_run_id`。
3. Dispatcher 调用执行平面，携带 `trigger_type=scheduled` 与 `job_run_id`。
4. runtime 执行并回传结果。
5. 控制层更新 `schedule_runs`，必要时按策略重试。

---

## 4. 后端设计

## 4.1 数据模型

建议新增表：

- `agent_schedules`
  - `id` (uuid)
  - `org_id`, `created_by`, `agent_id`
  - `name`, `description`
  - `schedule_type` (`cron` | `interval` | `once`)
  - `cron_expr`, `timezone`, `interval_seconds`, `run_at`
  - `payload` (jsonb)  // 触发 prompt、上下文参数、输出要求
  - `enabled` (bool)
  - `next_run_at`, `last_run_at`
  - `retry_policy` (jsonb)
  - `created_at`, `updated_at`

- `schedule_runs`
  - `id` (uuid), `schedule_id`
  - `job_run_id` (唯一)
  - `status` (`queued` | `running` | `success` | `failed` | `timeout` | `cancelled`)
  - `started_at`, `finished_at`, `duration_ms`
  - `attempt`, `error_code`, `error_message`
  - `session_id`, `message_id`（关联聊天结果）
  - `result_summary` (jsonb)
  - `created_at`

- `schedule_delivery_configs`（可选）
  - webhook/slack/email 等交付配置

## 4.2 API 设计（建议）

- `POST /api/v1/schedules`
- `GET /api/v1/schedules`
- `GET /api/v1/schedules/:id`
- `PATCH /api/v1/schedules/:id`
- `POST /api/v1/schedules/:id/enable`
- `POST /api/v1/schedules/:id/disable`
- `POST /api/v1/schedules/:id/run-now`
- `GET /api/v1/schedules/:id/runs`
- `GET /api/v1/schedule-runs/:runId`
- `POST /api/v1/schedule-runs/:runId/retry`

权限建议：

- `schedules:read`
- `schedules:write`
- `schedules:run`
- `schedules:delete`

## 4.3 调度策略

- 扫描周期：5~10 秒（开发），生产可按负载调优。
- 防重：`job_run_id` 幂等 + DB 唯一索引。
- 重试：指数退避（30s/60s/300s/900s/3600s），最大次数可配置。
- 漏触发补偿：
  - 短暂中断恢复后，补偿最近窗口（例如 15 分钟）。
  - 超长停机不回放全部历史，避免雪崩。
- 并发控制：
  - 每组织并发上限
  - 每 schedule 并发上限（默认 1，避免重复叠跑）

## 4.4 与执行平面的协议

触发 payload 新增字段：

- `trigger_type: "scheduled"`
- `schedule_id`
- `job_run_id`
- `attempt`
- `schedule_payload`（标准化任务描述）

执行完成回传：

- `job_run_id`
- `status`
- `session_id`, `message_id`
- `error_code/error_message`（失败时）

---

## 5. 前端设计

## 5.1 页面策略（关键决策）

采用 `独立页面 + 聊天快捷入口`：

- 独立页面（必需）：
  - 路由建议：`/automation/schedules`
  - 能力：列表筛选、创建编辑、启停、run logs、重跑、错误排查
  - 适合运维与长期管理

- 聊天快捷入口（增强）：
  - 在 `chat/[sessionId]` 结果区域增加 “设为定时任务”
  - 自动预填 prompt / 目标 Agent / 输出要求
  - 点击后跳转到创建抽屉或弹窗，最终写入同一 Schedule API

这样既不污染聊天主流程，也不会割裂“从一次成功对话沉淀为自动化任务”的路径。

## 5.2 关键页面与组件

- `SchedulesPage`
  - 任务表格（状态、下次执行、最近结果、失败次数）
  - 批量启停
- `ScheduleEditorDrawer`
  - 基础信息
  - 调度表达式（cron/interval/once）
  - 时区选择
  - 重试策略
  - 执行 payload 编辑
- `RunLogsPanel`
  - 最近执行记录
  - 展开查看错误与关联会话
- `CreateFromChatAction`
  - 聊天页面快捷生成

## 5.3 交互与可用性

- cron 输入支持人类可读预览（下一次执行时间）。
- 保存前即时校验表达式与时区。
- 对失败 run 提供“重试”和“跳转会话”。
- 刷新后日志与状态不丢失（完全来自服务端）。

---

## 6. 监控与审计

- 指标：
  - schedule 数量、启用数
  - 每分钟触发数
  - success/failed/timeout 比率
  - P95 执行时长
- 审计：
  - schedule 的创建/编辑/启停/删除
  - run-now / retry 操作
- 告警：
  - 连续失败 N 次
  - 全局调度器停摆

---

## 7. 分阶段落地

Phase 1（MVP）

- `agent_schedules + schedule_runs` 表
- Scheduler 扫描与触发
- 基础 API + 独立页面列表/创建/启停/日志

Phase 2

- 聊天页“设为定时任务”快捷入口
- run-now / retry / 失败原因增强

Phase 3

- Webhook/Slack 等交付通道
- 更完整的补偿策略与配额治理

---

## 8. 非目标（当前阶段）

- 不在执行层实现持久调度状态。
- 不在聊天页承载完整任务管理后台。
- 不在首版引入复杂事件源（如 Gmail Pub/Sub），先做 cron/interval/once。

