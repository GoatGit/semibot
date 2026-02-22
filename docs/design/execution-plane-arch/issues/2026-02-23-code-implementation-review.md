# 执行平面代码实现审查报告

- 审查日期: 2026-02-23
- 审查范围: 全部实现代码 vs 架构文档（01~06）
- 结论: 发现 4 个 BUG 级问题、4 个协议偏差、5 个功能缺失、5 个健壮性问题、2 个文档偏差，共 20 项。

---

## 一、BUG 级问题（会导致运行时错误）

### 1. [阻断] cancel 发送条件反转

- 文件: `apps/api/src/services/chat.service.ts:330-338`
- 问题:

```typescript
res.on('close', () => {
    if (!connection.isActive) {  // ← 条件反了
      try {
        wsServer.sendCancel(userId, sessionId)
      } catch {
        // ignore disconnect race
      }
    }
  })
```

`closeSSEConnection` 会将 `isActive` 设为 `false`，而 `res.on('close')` 在 SSE 连接关闭时触发。当前逻辑：只有连接已被我们主动关闭后才发 cancel；用户主动断开（浏览器关闭）时 `isActive` ��为 `true`，反而不发 cancel。

- 修复: 将 `!connection.isActive` 改为 `connection.isActive`。

### 2. [阻断] cancel 事件类型与协议不一致

- 文件: `runtime/src/session/semigraph_adapter.py:83-90, 192-205`
- 问题: 架构文档（05-WEBSOCKET-PROTOCOL.md §5.6）明确规定 cancel 后应发送 `execution_complete`（附带 `cancelled: true`），这是唯一的取消完成事件。但代码发送的是 `execution_error` + `code: EXECUTION_CANCELLED`。

```python
# 当前（错误）
await self.client.send_sse_event(self.session_id, {
    "type": "execution_error",
    "code": "EXECUTION_CANCELLED",
    "error": "Execution cancelled",
})

# 应改为
await self.client.send_sse_event(self.session_id, {
    "type": "execution_complete",
    "cancelled": True,
})
```

- 影响: 前端收到错误事件而非正常的取消完成事件，UI 可能显示错误提示而非"已停止"。
- 修复: `cancel()` 和 `_run()` 中的 `CancelledError` 分支都改为发送 `execution_complete` + `cancelled: true`。

### 3. [高] SSE 转发事件名 `done` 与协议不一致

- 文件: `apps/api/src/ws/ws-server.ts:434`
- 问题:

```typescript
forwardSSE(msg.session_id, 'done', { sessionId: msg.session_id, messageId })
```

架构文档已统一事件名为 `execution_complete`，但代码仍发送 `done`。前端如果按新协议监听 `execution_complete`，会收不到完成事件。

- 修复: 将 `'done'` 改为 `'execution_complete'`。

### 4. [高] 环境变量名不一致

- 文件: `runtime/src/main.py:17` vs `apps/api/src/scheduler/vm-scheduler.ts:211` vs 架构文档 04-EXECUTION-PLANE.md §5 环境变量表
- 问题:
  - `main.py` 读取 `VM_USER_ID`
  - `vm-scheduler.ts` bootstrap 传入 `VM_USER_ID`
  - 架构文档定义的是 `USER_ID`
- 修复: 统一为 `VM_USER_ID`（scheduler 已使用此名），更新架构文档。

---

## 二、协议偏差（代码与文档不匹配）

### 5. [高] ticket 验证缺失

- 文件: `apps/api/src/ws/ws-server.ts:155-206`
- 问题: 架构文档定义首次连接需验证 `ticket`（一次性票据，反滥用），但 `handleConnection` 只从 URL 提取了 `user_id`，完全没有读取或验证 `ticket` 参数。ticket 的反滥用功能形同虚设。
- 修复: 从 URL query 读取 `ticket`，首次连接时验证其有效性（查数据库或 Redis），验证后立即失效。重连时允许无 ticket。

### 6. [中] API Key 明文传输

- 文件: `apps/api/src/ws/ws-server.ts:209-214`
- 问题: 架构文档要求 `init` 消息中的 `api_keys` 字段为加密传输，执行平面在内存中解密使用。但代码直接从 `process.env` 明文读取并下发，无任何加密处理。
- 修复: 实现对称加密（如 AES-256-GCM），用 VM token 派生密钥加密 API Key，执行平面收到后解密。

### 7. [中] `resume_response` 未在主消息循环中处理

- 文件: `runtime/src/ws/client.py:190-209`
- 问题: `_reconnect` 方法中用 `await self.ws.recv()` 同步等待 `resume_response`，但如果控制平面在 `resume_response` 之前发了其他消息（如 `start_session`），会导致消息丢失或解析错误。
- 修复: 在 `_listen_loop` 中统一处理 `resume_response` 消息类型，`_reconnect` 通过 Future 等待结果。

### 8. [低] `ensureUserVM` 中 `terminated` 状态检查为死代码

- 文件: `apps/api/src/scheduler/vm-scheduler.ts:58-67`
- 问题: `getActiveVM` 查询条件已排除 `status IN ('terminated', 'failed')`，所以 `active.status === 'terminated'` 永远不会为 `true`。这个分支是死代码。
- 修复: 移除 `'terminated'` 检查，仅保留 `'failed'`。

---

## 三、功能缺失

### 9. [高] `memory_search` 是 ILIKE 全文搜索，非向量搜索

- 文件: `apps/api/src/ws/ws-server.ts:316-336`
- 问题:

```typescript
AND content ILIKE ${`%${query}%`}
```

架构文档设计的是 pgvector 向量搜索，当前用 ILIKE 字符串匹配，`score` 硬编码为 `1`。数据量大时性能极差，语义搜索能力为零。

- 修复: 集成 pgvector，使用 embedding 向量做相似度搜索。短期可保留 ILIKE 作为 fallback，但 `score` 应反映实际相关度。

### 10. [高] Skill 依赖检查未实现

- 文件: 架构文档 04-EXECUTION-PLANE.md §8 定义了 `check_skill_requirements()`
- 问题: Python 侧完全没有实现依赖检查（`requires.binaries` / `requires.env_vars`）。`SemiGraphAdapter` 启动时不做任何校验，不满足依赖的 skill 仍会被注入索引，导致 LLM 尝试调用不可用的技能。
- 修复: 在 `SessionManager.start_session` 中实现 `check_skill_requirements()`，过滤不满足依赖的 skill。

### 11. [中] `file_inventory` 和 `requires` 硬编码

- 文件: `apps/api/src/services/chat.service.ts:283-293`
- 问题:

```typescript
file_inventory: { has_skill_md: true, has_scripts: true, has_references: true },
requires: { binaries: [], env_vars: [] },
```

所有 skill 的 `file_inventory` 都硬编码为全 `true`，`requires` 都为空数组。应从 skill 定义或包元数据中读取实际值。

- 修复: 从 `skill_packages` 表或包目录中读取实际的 `file_inventory` 和 `requires`。

### 12. [低] `config_update` 消息类型未实现

- 文件: 架构文档 05-WEBSOCKET-PROTOCOL.md §5.7
- 问题: 协议定义了 `config_update` 热更新消息，但控制平面和执行平面都没有实现。
- 修复: 可延后实现，但需在文档中标注为 "Phase 2"。

### 13. [低] 长期记忆写入是 no-op

- 文件: `runtime/src/memory/ws_memory.py:61-71`
- 问题: `save_long_term` 是空实现，协议中也没有定义 `memory_write` 方法。Agent 保存长期记忆时数据静默丢失。
- 修复: 在协议中增加 `memory_write` fire_and_forget 方法，或通过 `fire_and_forget('memory_save', ...)` 实现。

---

## 四、健壮性问题

### 14. [高] `handleMessage` 无 JSON 解析保护

- 文件: `apps/api/src/ws/ws-server.ts:251-252`
- 问题:

```typescript
const msg = JSON.parse(raw) as WSIncomingMessage
```

如果执行平面发送非法 JSON，`JSON.parse` 抛异常，导致整个消息处理中断。

- 修复: 包裹 try-catch，非法消息记录日志后跳过。

### 15. [高] 心跳循环异常后静默退出

- 文件: `runtime/src/ws/client.py:173-180`
- 问题:

```python
async def _heartbeat_loop(self) -> None:
    while True:
        await asyncio.sleep(10)
        ...
        except Exception:
            return  # ← 任何异常都导致心跳永久停止
```

一次发送失败就永久停止心跳，控制平面会在 30 秒后判定超时断开连接。

- 修复: 捕获异常后重试，或在异常时触发重连流程。

### 16. [中] JWT secret 硬编码 fallback

- 文件: `apps/api/src/scheduler/vm-scheduler.ts:230`, `apps/api/src/ws/ws-server.ts:221`
- 问题:

```typescript
const secret = process.env.JWT_SECRET ?? 'development-secret-change-in-production'
```

生产环境如果忘记设置 `JWT_SECRET`，所有 VM token 都用同一个弱密钥签发。

- 修复: 生产环境（`NODE_ENV=production`）缺少 `JWT_SECRET` 时直接抛错拒绝启动。

### 17. [中] `OpenClawBridgeAdapter` 缺少快照同步

- 文件: `runtime/src/session/openclaw_adapter.py`
- 问题: `RuntimeAdapter` 基类没有定义 `get_snapshot`（与文档不同），`OpenClawBridgeAdapter` 也没有实现快照同步。OpenClaw session 的状态无法定期同步到控制平面。
- 修复: 在 `RuntimeAdapter` 基类增加可选的 `get_snapshot` 方法，`OpenClawBridgeAdapter` 通过 Bridge IPC 获取快照。

### 18. [低] `session_snapshots` 表无清理机制

- 文件: `apps/api/src/ws/ws-server.ts:490-511`（snapshot_sync 处理）
- 问题: 每次 `snapshot_sync` 都 INSERT 新行，没有清理旧快照的逻辑。长期运行会导致表无限膨胀。
- 修复: INSERT 后删除同 session 的旧快照（保留最近 3 个），或用定时任务清理。

---

## 五、文档偏差（代码正确但文档需同步）

### 19. [低] `SessionManager._create_adapter` 签名与文档不同

- 文件: `runtime/src/session/manager.py:72-86` vs 04-EXECUTION-PLANE.md §6
- 问题: 文档定义的工厂函数是 `create_adapter(runtime_type, client, memory_dir)`，实际代码是类方法 `_create_adapter(runtime_type, session_id, data)`。`SemiGraphAdapter` 构造函数接收 6 个参数（client, session_id, org_id, user_id, init_data, start_payload）而非文档中的 2 个（client, memory_dir）。
- 修复: 更新文档中的代码示例，与实际实现对齐。

### 20. [低] OpenClaw Bridge IPC 方式与文档不同

- 文件: `runtime/src/session/openclaw_adapter.py` vs 04-EXECUTION-PLANE.md §4.5
- 问题: 文档设计的是 Unix Domain Socket IPC，实际实现用的是 stdin/stdout JSON-line 协议。功能等价但实现方式不同。
- 修复: 更新文档，将 IPC 方式改为 stdin/stdout JSON-line。

---

## 修复优先级建议

| 阶段 | 问题编号 | 说明 |
|------|---------|------|
| 立即修复 | #1, #2, #3, #4 | BUG 级，直接导致运行时行为错误 |
| 短期修复 | #5, #7, #9, #10, #14, #15 | 协议偏差 + 功能缺失 + 健壮性，影响可靠性 |
| 中期修复 | #6, #8, #11, #16, #17, #18 | 安全 + 清理 + 完整性 |
| 可延后 | #12, #13, #19, #20 | 功能扩展 + 文档同步 |
