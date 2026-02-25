# TASKS: Cron 调度能力（Control Plane）

## 0. 总体原则

- 调度在控制层，执行在执行层。
- 先交付 MVP 主路径：可创建、可触发、可观测、可重试。
- 每个里程碑必须附带测试与回归清单。

## 1. M1 数据层（DB + Repository）

### 任务

- 新增 migration：`agent_schedules` 表
- 新增 migration：`schedule_runs` 表
- 新增必要索引：
  - `(org_id, enabled, next_run_at)`
  - `(schedule_id, created_at desc)`
  - `job_run_id unique`
- Repository 层：
  - schedule CRUD
  - run create/update/query
  - 幂等插入（job_run_id）

### 验收

- migration 可重复部署（dev/stage）
- repository 单测通过
- 幂等冲突能稳定返回而非脏数据

## 2. M2 调度核心（Scheduler + Dispatcher）

### 任务

- 新增 `apps/api/src/services/scheduler.service.ts`
- 新增扫描循环（5~10s）
- 计算 next_run_at（cron/interval/once + timezone）
- 触发 dispatcher 生成 `job_run_id`
- 写入 `schedule_runs(queued/running)`
- 调用执行平面（start_session + scheduled payload）
- 回写 run 状态（success/failed/timeout）

### 验收

- 创建 cron 后可自动触发
- 关联 session/message 可追踪
- 调度器重启后任务继续执行

## 3. M3 API 与权限

### 任务

- 新增路由：`apps/api/src/routes/v1/schedules.ts`
- 接口实现：
  - create/list/get/update/enable/disable/run-now/runs/retry
- 权限点：
  - `schedules:read`
  - `schedules:write`
  - `schedules:run`
  - `schedules:delete`
- 参数校验：
  - cron 表达式
  - timezone
  - interval 下限/上限

### 验收

- OpenAPI/路由测试通过
- 无权限用户返回正确错误码
- 参数非法时返回可读错误

## 4. M4 前端独立页面（主入口）

### 任务

- 新增页面：`apps/web/app/(dashboard)/automation/schedules/page.tsx`
- 新增组件：
  - `SchedulesTable`
  - `ScheduleEditorDrawer`
  - `RunLogsPanel`
- 支持：
  - 列表筛选（状态/Agent）
  - 新建编辑
  - 启停
  - run-now
  - runs 查看与失败重试

### 验收

- 完成任务全生命周期管理
- 刷新后状态一致
- 错误提示明确

## 5. M5 聊天流程快捷入口（辅入口）

### 任务

- 在 `chat/[sessionId]` 结果区新增按钮：`设为定时任务`
- 自动预填：
  - agent
  - prompt
  - 输出类型（如 PDF/XLSX）
- 提交仍调用统一 schedules API

### 验收

- 一次成功聊天可在 2~3 步内转为 schedule
- 创建后在 `/automation/schedules` 可见

## 6. M6 重试与可靠性

### 任务

- 指数退避策略（30/60/300/900/3600s）
- 最大重试次数配置化
- 失败后可手动 retry
- 并发控制：
  - org 级并发上限
  - schedule 级并发上限（默认 1）

### 验收

- 连续失败任务按策略重试
- 无重复执行（job_run_id 幂等）
- 高并发下无重复 run

## 7. M7 监控与审计

### 任务

- 指标埋点：
  - trigger_count
  - run_success_rate / run_failure_rate
  - run_duration_p95
- 审计日志：
  - 创建/编辑/启停/删除
  - run-now/retry
- 告警规则：
  - 连续失败 N 次
  - 调度器停摆

### 验收

- 可查询近 24h 指标
- 审计日志可按 schedule/user 过滤
- 告警触发可验证

## 8. 测试与回归清单

### 自动化

- API 单元测试（routes/services/repo）
- Scheduler 集成测试（时间推进 + 触发验证）
- 前端组件测试（创建/编辑/启停/runs）
- E2E：从创建任务到自动触发到结果落库

### 手工回归

- 时区切换（Asia/Shanghai/UTC）
- cron 边界（整点、高频、月底）
- 执行平面不可用时失败路径
- 重试后恢复路径

## 9. 交付顺序建议

1. M1 + M2（先打通后端触发闭环）
2. M3（开放 API）
3. M4（独立页面）
4. M5（聊天快捷入口）
5. M6 + M7（稳定性与运维）

## 10. 可执行任务分解（可直接开工）

## 10.1 Backend - 数据与调度

- [ ] T1. 新增 migration：`database/migrations/021_agent_schedules.sql`
- [ ] T2. 新增 migration：`database/migrations/022_schedule_runs.sql`
- [ ] T3. 新增 repository：`apps/api/src/repositories/schedules.repository.ts`
- [ ] T4. 新增 repository：`apps/api/src/repositories/schedule-runs.repository.ts`
- [ ] T5. 新增 service：`apps/api/src/services/scheduler.service.ts`
- [ ] T6. 新增 dispatcher：`apps/api/src/services/schedule-dispatcher.service.ts`
- [ ] T7. 在 `apps/api/src/index.ts` 挂载 scheduler 启停生命周期
- [ ] T8. 在 `apps/api/src/ws/ws-server.ts` 增加 scheduled trigger 元数据透传（`trigger_type/schedule_id/job_run_id/attempt`）

## 10.2 Backend - API 与权限

- [ ] T9. 新增路由：`apps/api/src/routes/v1/schedules.ts`
- [ ] T10. 在 `apps/api/src/routes/v1/index.ts` 注册 schedules 路由
- [ ] T11. 在权限种子/常量处增加 `schedules:read/write/run/delete`
- [ ] T12. 新增 DTO 与 zod 校验（cron/timezone/interval/once）
- [ ] T13. 新增 run-now / retry 接口实现

## 10.3 Frontend - 独立页面

- [ ] T14. 新增页面：`apps/web/app/(dashboard)/automation/schedules/page.tsx`
- [ ] T15. 新增组件：`apps/web/components/schedules/SchedulesTable.tsx`
- [ ] T16. 新增组件：`apps/web/components/schedules/ScheduleEditorDrawer.tsx`
- [ ] T17. 新增组件：`apps/web/components/schedules/RunLogsPanel.tsx`
- [ ] T18. 新增 hook：`apps/web/hooks/useSchedules.ts`
- [ ] T19. 导航入口接入（侧边栏 Automation 菜单）

## 10.4 Frontend - 聊天快捷入口

- [ ] T20. 在 `apps/web/app/(dashboard)/chat/[sessionId]/page.tsx` 增加“设为定时任务”入口
- [ ] T21. 增加快捷创建弹窗/抽屉并预填 prompt、agent、输出要求
- [ ] T22. 提交走统一 schedules API，创建后跳转任务详情

## 10.5 测试与质量

- [ ] T23. 新增 API 单测：`apps/api/src/__tests__/schedules.route.test.ts`
- [ ] T24. 新增 service 单测：`apps/api/src/__tests__/scheduler.service.test.ts`
- [ ] T25. 新增调度集成测试：`apps/api/src/__tests__/scheduler.integration.test.ts`
- [ ] T26. 新增前端组件测试：`apps/web/components/schedules/*.test.tsx`
- [ ] T27. 新增 E2E：`tests/e2e/schedules-flow.spec.ts`
- [ ] T28. 回归 existing 聊天 E2E，确保 scheduled 元数据不破坏现有流程

## 10.6 运维与监控

- [ ] T29. 指标埋点接入（触发数/成功率/失败率/P95）
- [ ] T30. 审计日志接入（create/update/enable/disable/run-now/retry）
- [ ] T31. 新增告警规则（连续失败 N 次、调度停摆）
- [ ] T32. 增加运维文档：故障排查与手动补偿操作

## 11. 依赖关系

- `T1~T4` 是 `T5~T13` 前置
- `T9~T13` 是 `T14~T22` 前置
- `T5~T13 + T14~T22` 完成后再做 `T23~T28`
- `T29~T32` 可与测试阶段并行推进

## 12. 工期建议（1~2 人）

- M1~M2：3~4 天
- M3：2 天
- M4：3 天
- M5：1~2 天
- M6~M7：2~3 天
- 总计：11~14 天

## 13. 开工前检查项（Blocking）

- [ ] B1. 确认执行平面触发接口稳定（start_session 或等价接口）并有幂等字段扩展位
- [ ] B2. 确认权限模型支持新增 `schedules:*` 资源
- [ ] B3. 确认前端路由分组 `(dashboard)/automation` 可直接挂页
- [ ] B4. 确认 observability 管道可接入新增 metrics/audit
- [ ] B5. 确认 staging 环境可做时间推进类测试（scheduler integration）

## 14. 里程碑 DoD（Definition of Done）

### DoD-M1（数据层）

- migration 在 dev/stage 成功执行
- repository 单测通过且覆盖幂等冲突路径
- `job_run_id` 唯一冲突不会导致业务异常写入

### DoD-M2（调度核心）

- cron/interval/once 在指定时区均可触发
- run 状态机完整（queued/running/success/failed/timeout）
- 调度器重启后可继续调度（无全量漏触发）

### DoD-M3（API）

- OpenAPI 或接口文档同步
- 鉴权/鉴租户正确，跨 org 访问被拒绝
- run-now/retry 响应与运行记录一致

### DoD-M4（前端独立页）

- 能完成列表、创建、编辑、启停、run-now、查看 runs、retry
- 刷新后数据一致，错误提示可读
- 空状态/加载态/失败态完整

### DoD-M5（聊天快捷入口）

- 从聊天页可一键预填创建 schedule
- 创建成功可跳转并定位到对应 schedule
- 不影响现有聊天消息渲染与下载链路

### DoD-M6/M7（可靠性与运维）

- 失败重试策略可验证
- 指标与告警可验证（人工触发）
- 审计日志可按用户、schedule、时间过滤
