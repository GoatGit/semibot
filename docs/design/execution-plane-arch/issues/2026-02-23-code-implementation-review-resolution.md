# 2026-02-23 审查问题修复对照

> 基于 `2026-02-23-code-implementation-review.md` 的 20 项问题，记录当前代码落地位置。

## 一、BUG 级问题

1. cancel 发送条件反转  
已修复：`apps/api/src/services/chat.service.ts`

2. cancel 事件类型不一致  
已修复：`runtime/src/session/semigraph_adapter.py`

3. SSE 完成事件名 `done` 不一致  
已修复：`apps/api/src/ws/ws-server.ts`

4. VM 用户环境变量命名不一致  
已修复：`runtime/src/main.py`、`apps/api/src/scheduler/vm-scheduler.ts`、`docs/design/execution-plane-arch/04-EXECUTION-PLANE.md`

## 二、协议偏差

5. ticket 验证缺失  
已修复：`apps/api/src/ws/ws-server.ts`、`apps/api/src/scheduler/vm-scheduler.ts`、`database/migrations/020_user_vm_instances_connect_ticket.sql`

6. API Key 明文传输  
已修复：`apps/api/src/ws/ws-server.ts`、`runtime/src/security/api_key_cipher.py`、`runtime/src/session/manager.py`

7. `resume_response` 主循环未处理  
已修复：`runtime/src/ws/client.py`

8. `ensureUserVM` 死代码分支  
已修复：`apps/api/src/scheduler/vm-scheduler.ts`

## 三、功能缺失

9. `memory_search` 非向量检索  
已修复：`apps/api/src/ws/ws-server.ts`（向量优先 + ILIKE fallback）  
测试：`apps/api/src/__tests__/ws.server.memory-search.test.ts`

10. Skill 依赖检查未实现  
已修复：`runtime/src/session/manager.py`  
测试：`runtime/tests/session/test_session_manager_requirements.py`

11. `file_inventory` / `requires` 硬编码  
已修复：`apps/api/src/services/chat.service.ts`

12. `config_update` 未实现  
已修复：`apps/api/src/ws/ws-server.ts`、`runtime/src/main.py`、`runtime/src/ws/client.py`、`runtime/src/session/manager.py`、`runtime/src/session/openclaw_adapter.py`、`runtime/openclaw-bridge/src/*`

13. 长期记忆写入 no-op  
已修复：`runtime/src/memory/ws_memory.py`、`apps/api/src/ws/ws-server.ts`、`docs/design/execution-plane-arch/05-WEBSOCKET-PROTOCOL.md`

## 四、健壮性问题

14. `handleMessage` JSON 无保护  
已修复：`apps/api/src/ws/ws-server.ts`  
测试：`apps/api/src/__tests__/ws.server.request-fireforget.test.ts`

15. 心跳异常后静默退出  
已修复：`runtime/src/ws/client.py`

16. JWT secret 弱 fallback  
已修复：`apps/api/src/ws/ws-server.ts`、`apps/api/src/scheduler/vm-scheduler.ts`

17. OpenClaw 快照同步缺失  
已修复：`runtime/src/session/runtime_adapter.py`、`runtime/src/session/openclaw_adapter.py`、`runtime/openclaw-bridge/src/*`

18. `session_snapshots` 无清理  
已修复：`apps/api/src/ws/ws-server.ts`

## 五、文档偏差

19. SessionManager 工厂签名与文档不一致  
已修复：`docs/design/execution-plane-arch/04-EXECUTION-PLANE.md`

20. OpenClaw IPC 方式与文档不一致  
已修复：`docs/design/execution-plane-arch/04-EXECUTION-PLANE.md`、`docs/design/execution-plane-arch/06-MIGRATION-PLAN.md`
