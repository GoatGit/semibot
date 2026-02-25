# PRD: Cron 调度能力（Control Plane）

## 1. 背景

当前 Semibot 主要由用户对话触发执行，缺少“定时自动执行”的平台能力。目标是引入 Cron 调度，使 Agent 可按计划主动运行，同时保持执行平面无状态。

## 2. 产品目标

- 支持用户为 Agent 配置 `cron/interval/once` 任务。
- 支持启用/禁用、立即执行、执行历史查看、失败重试。
- 保证多租户隔离、权限控制、审计可追踪。
- 与现有聊天/执行平面打通，结果可回溯到 session/message。

## 3. 范围

## 3.1 In Scope

- 控制层调度服务（Scheduler + Dispatcher）
- 调度数据模型（schedules/runs）
- 调度管理 API
- 前端调度管理页面（独立页面）
- 聊天页“设为定时任务”快捷入口
- 调度运行日志与失败重试

## 3.2 Out of Scope（首版）

- Gmail Pub/Sub 等复杂事件源
- 全部外部交付渠道（仅预留扩展位）
- 执行层持久化调度状态

## 4. 关键决策

- 调度能力归属：`控制层`
- 执行能力归属：`执行层`
- 前端形态：`独立页面为主 + 聊天内快捷入口为辅`

## 5. 核心用户故事

1. 作为运营人员，我希望每天 07:00 自动生成指定 Agent 报告。  
2. 作为管理员，我希望查看所有计划任务状态与最近失败原因。  
3. 作为分析师，我希望把一次成功聊天快速沉淀为定时任务。  
4. 作为值班人员，我希望失败任务可一键重试并追踪结果。  

## 6. 功能需求

- 任务管理：创建、编辑、启停、删除、Run now
- 调度表达式：cron/interval/once + timezone
- 运行记录：状态、耗时、错误、关联 session/message
- 重试策略：指数退避 + 最大次数
- 幂等：`job_run_id` 唯一防重
- 审计：任务配置变更与运行操作留痕

## 7. 非功能需求

- 多租户隔离：org 级别强约束
- 可观测：触发量、成功率、失败率、P95 耗时
- 可恢复：调度器重启后不中断，支持有限补偿
- 安全：权限分级（read/write/run/delete）

## 8. API 概览

- `POST /api/v1/schedules`
- `GET /api/v1/schedules`
- `PATCH /api/v1/schedules/:id`
- `POST /api/v1/schedules/:id/enable`
- `POST /api/v1/schedules/:id/disable`
- `POST /api/v1/schedules/:id/run-now`
- `GET /api/v1/schedules/:id/runs`
- `POST /api/v1/schedule-runs/:runId/retry`

## 9. 数据模型概览

- `agent_schedules`
- `schedule_runs`
- （可选）`schedule_delivery_configs`

## 10. 验收标准（MVP）

- 能在 UI 创建并启用一个 cron 任务（含时区）。
- 到点后可触发执行平面执行并产生 session 结果。
- runs 列表可见执行状态与错误信息。
- 失败任务可重试，且能正确更新状态。
- 刷新页面后任务与运行历史不丢失。

## 11. 风险与缓解

- 风险：任务并发导致重复执行  
  - 缓解：`job_run_id` 唯一约束 + schedule 并发上限
- 风险：调度器故障导致漏触发  
  - 缓解：有限补偿窗口 + 监控告警
- 风险：执行平面波动导致大量失败  
  - 缓解：指数退避 + 失败告警 + 手动重试入口

## 12. 里程碑 Gate（发布门槛）

### Gate A（后端闭环）

- 已支持 create/enable/run-now/runs/retry API
- 调度到点可稳定触发执行平面
- run 记录可关联 session/message

### Gate B（前端可用）

- `/automation/schedules` 可完成任务全生命周期管理
- 支持失败任务重试与错误查看
- 聊天页“设为定时任务”入口可用

### Gate C（上线就绪）

- 指标与审计齐全
- 告警规则可触发并验证
- 完成回归测试（API + 前端 + E2E）

## 13. 成功指标（上线后 2 周）

- 调度任务创建转化率 > 20%（从聊天入口创建）
- 调度执行成功率 >= 95%
- 重复执行事故 = 0（幂等保障）
- P95 调度触发延迟 < 15s

## 14. 需求-验收-任务追踪矩阵

| 需求ID | 需求描述 | 核心验收点 | 任务映射 |
| --- | --- | --- | --- |
| R1 | 可创建/编辑/启停 schedule | UI/API 均可操作，参数校验完整 | T1~T4, T9~T13, T14~T19 |
| R2 | 到点自动触发并产生可追踪执行结果 | run 记录关联 session/message | T5~T8, T25, T27 |
| R3 | 支持 run-now 与失败 retry | 手动触发与重试状态正确 | T13, T17, T23, T27 |
| R4 | 聊天可一键沉淀为定时任务 | 2~3 步完成创建并跳转 | T20~T22, T28 |
| R5 | 具备可观测与审计能力 | 指标可查、审计可追溯、告警可触发 | T29~T32 |

## 15. 发布策略（建议）

- Feature Flag：`feature.schedules.enabled`
- 分阶段发布：
  - 阶段 1：仅管理员可见（灰度组织）
  - 阶段 2：全员可创建，仅管理员可删除
  - 阶段 3：按权限模型完全开放
- 数据安全：
  - 发布前执行 migration dry-run（dev/stage）
  - 发布后 24h 内重点监控重复执行、失败率、调度延迟

## 16. 回滚策略

- 应用层回滚：关闭 `feature.schedules.enabled`，保留数据不删表。
- 调度器回滚：停止 scheduler loop，避免新任务继续触发。
- 数据层回滚：不建议直接回滚 migration；如需回退，先停调度再做只读导出。
- 应急操作：
  - 批量 disable schedule
  - 按 org 粒度熔断调度触发
  - 保留 runs 历史用于故障追溯
