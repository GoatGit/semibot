# Execution Plane 架构设计复审报告（第三轮）

- 日期：2026-02-21
- 范围：`docs/design/execution-plane-arch/`
- 结论：~~上一轮多数问题已修复；仍存在 7 个需处理问题，其中 2 个为阻断级。~~ **全部 7 个问题已修复。**

## 关键发现（按严重度）

### 1) [阻断] ~~一次性 `ticket` 与重连机制冲突~~ ✅ 已修复
- 修复: 重连 URL 不带 ticket，仅携带 `user_id`。认证通过首帧 `auth` 消息传输 JWT。已更新 `04-EXECUTION-PLANE.md` 和 `05-WEBSOCKET-PROTOCOL.md`。

### 2) [阻断] ~~`user_vm_instances.status` 约束与索引条件不一致~~ ✅ 已修复
- 修复: `status` 枚举增加 `failed`，索引条件保持 `NOT IN ('terminated', 'failed')`。已更新 `03-CONTROL-PLANE.md` 和 `06-MIGRATION-PLAN.md`。

### 3) [高] ~~VM 模式字段命名/默认值不一致~~ ✅ 已修复
- 修复: 组织级统一为 `default_vm_mode`，默认值统一为 `docker`。

### 4) [高] ~~用户级 `routing_mode` 继承语义冲突~~ ✅ 已修复
- 修复: `users.routing_mode` 默认 `NULL`（继承组织级），已移除 `DEFAULT 'http'`。

### 5) [中] ~~协议例外列表缺少 `auth`~~ ✅ 已修复
- 修复: 在协议总则例外中显式加入 `auth`。

### 6) [低] ~~迁移前置条件残留旧术语 `legacy`~~ ✅ 已修复
- 修复: 统一改为 `routing_mode='http'`。

### 7) [低] ~~架构总览残留旧 SSE 事件名 `done`~~ ✅ 已修复
- 修复: 统一为 `execution_complete`。

## 本轮确认已修复项

1. `user_message` 已改为顶层 `session_id`（与协议一致）。
2. 重连顺序已统一为"先 `init` 后 `resume`"。
3. 协议已明确 `response/resume_response` 可不携带 `session_id`。
4. 已引入 `routing_mode` 与 `vm_mode` 语义拆分方向。
5. 已加入"每用户一个 active VM"的唯一索引思路。

## 确认结果

1. ~~`ticket` 一次性策略是否保留？~~ → 保留，重连不用 ticket，仅靠 JWT
2. ~~`status` 是否正式引入 `failed`？~~ → 是
3. ~~组织级 VM 模式字段最终叫什么？~~ → `default_vm_mode`
4. ~~用户级 `routing_mode` 是否允许 `NULL` 继承？~~ → 是
