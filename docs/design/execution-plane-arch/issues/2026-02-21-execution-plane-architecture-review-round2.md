# Execution Plane 架构设计复审报告（第二轮）

- 日期：2026-02-21
- 范围：`docs/design/execution-plane-arch/`
- 结论：~~上一轮高优先问题大多已修复；仍有 6 个问题需要收敛，其中 3 个会直接影响实现正确性。~~ **全部 6 个问题已修复。**

## 已确认修复（相对上一轮）

1. `SessionManager` 已补 `adapter.start(session_id, config)` 初始化步骤。
2. `RuntimeAdapter` 调用统一为 `send_message`（不再混用 `execute`）。
3. `create_adapter()` 与 Adapter 构造参数已对齐。
4. `get_session` 已加入协议方法列表。
5. API Key 生命周期口径已统一为 VM 级 `init` 注入、VM 生命周期内共享。
6. SSE 事件名已朝统一规范收敛（`text_chunk` / `execution_complete`）。

## 剩余问题

### 1) [高] ~~`user_message` 字段层级与协议不一致~~ ✅ 已修复
- 修复: 统一为顶层 `session_id`（与 `type` 同级），已更新 `03-CONTROL-PLANE.md` 中的 `chat.service` 示例。

### 2) [高] ~~重连握手流程仍冲突~~ ✅ 已修复
- 修复: 统一为严格先 `init` 后 `resume`，已更新 `04-EXECUTION-PLANE.md` 中的 `_reconnect` 方法。

### 3) [高] ~~`execution_mode` 语义分裂（路由开关 vs 部署形态）~~ ✅ 已修复
- 修复: 拆分为 `routing_mode`（http/websocket）和 `vm_mode`（firecracker/docker/local），全部文档已同步。

### 4) [中] ~~协议总则与 `response/resume_response` 示例不一致~~ ✅ 已修复
- 修复: 更新协议总则，明确 VM 级消息（heartbeat/init/resume/response/resume_response/auth）不需要 `session_id`。

### 5) [中] ~~"每用户一个活跃 VM"缺数据库硬约束~~ ✅ 已修复
- 修复: 添加部分唯一索引 `WHERE status NOT IN ('terminated', 'failed')`。

### 6) [低] ~~仍有乱码与少量术语残留~~ ✅ 已修复
- 修复: 修复所有乱码字符，统一 `done` → `execution_complete`。

## 确认结果

1. ~~`execution_mode` 最终语义是什么？~~ → 拆分为 `routing_mode` + `vm_mode`
2. ~~重连握手以哪种为准？~~ → 必须先 `init` 再 `resume`
3. ~~`response/resume_response` 是否强制带 `session_id`？~~ → 不强制，通过 `id` (msg-uuid) 关联
4. ~~`user_message` 是否最终固定为顶层 `session_id`？~~ → 是
5. ~~是否同意增加"每用户一个 active VM"的部分唯一索引？~~ → 是
