# Ralph Agent Log

本文件记录每次 agent 迭代完成的工作。每次迭代追加到末尾。

---

## 2026-02-19 迭代 1 — Batch-1 验证通过

### US-R01 Repository 泛型基类抽取 → PASS ✅
- BaseRepository 已实现 findById、findByIdAndOrg、findByOrg（新增）、countByOrg、softDelete、findByIds
- agent/session/skill/mcp 4 个 Repository 已继承 BaseRepository
- 其余 10 个 Repository 保持函数式接口（视适用性）
- 新增 findByOrg 通用分页方法及对应测试
- 变更文件：`base.repository.ts`, `base.repository.test.ts`

### US-R05 请求追踪中间件 → PASS ✅
- tracing 中间件已实现并注册
- Runtime 侧 TraceMiddleware 已实现
- runtime.adapter.ts 已透传 X-Request-ID
- 所有测试通过，类型检查通过，无新增 lint warning

### 备注
- 4 个已有测试文件存在预先失败（errorHandler、evolved-skill-promote、skill-prompt-builder），与本次改动无关

## 2026-02-22 迭代 X — Execution Plane 重构主链路

### US-EPA-01 Execution Plane 三层架构重构 → PASS ✅
- API 新增控制平面 WS 模块：`apps/api/src/ws/*`
- API 新增 SSE 中继：`apps/api/src/relay/sse-relay.ts`
- Chat 服务切换为 WS 下发：`apps/api/src/services/chat.service.ts`
- Runtime 新增执行平面入口：`runtime/src/main.py`
- Runtime 新增 WS Client + SessionManager + RuntimeAdapter：`runtime/src/ws/client.py`, `runtime/src/session/*`
- 新增数据库迁移：`database/migrations/015_execution_plane_arch.sql`
- 验证：`pnpm --filter @semibot/api exec tsc --noEmit` 通过；`cd runtime && .venv/bin/python -m compileall src` 通过

### 2026-02-22 迭代 X+1 — Execution Plane 深化
- WS request 方法补全：`get_skill_package`（包文件读取）与 `memory_search`（文本回退检索）
- Agent/Session 数据模型贯通 `runtime_type` 与 `openclaw_config`
- API 路由移除 `/runtime` 挂载，避免继续暴露旧监控入口
- 验证通过：`pnpm --filter @semibot/api exec tsc --noEmit`，`cd runtime && .venv/bin/python -m compileall src`
- WS 上行 `fire_and_forget` 已接入（usage_report/audit_log/snapshot_sync/evolution_submit）
- 新增单测：`ws.message-router.test.ts`、`relay.sse-relay.test.ts`（共 9 个用例全通过）
- Runtime 新增 `WSMemoryProxy`：短期记忆落本地，长期记忆检索走控制平面 WS request(memory_search)

### 2026-02-22 迭代 X+2 — 测试补齐与取消态修复
- 新增 API 侧聊天 WS 路径测试：`chat-ws.integration.test.ts`
- 新增 API 侧 WS request/fire-and-forget 分发测试：`ws.server.request-fireforget.test.ts`
- 修复 Runtime `semigraph` 取消竞态：任务未进入 `_run` 即 cancel 时也会上报 `EXECUTION_CANCELLED`
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+3 — WS 协议恢复机制补齐
- 控制平面新增 `resume` 处理与 `resume_response` 返回：`apps/api/src/ws/ws-server.ts`
- 控制平面为 request 响应新增短期缓存（按 request id），支持断线恢复匹配
- 执行平面 WS 客户端补齐重连后的 `resume_response` 处理：`runtime/src/ws/client.py`
- 控制平面认证补充活跃 VM 校验（`user_vm_instances`）：
  - 默认启用
  - `NODE_ENV=test` 或 `WS_SKIP_VM_INSTANCE_CHECK=true` 时跳过
- 新增测试：`runtime/tests/ws/test_client_reconnect.py`（重连恢复 completed / lost）
- 新增测试：`apps/api/src/__tests__/ws.server.request-fireforget.test.ts` 中 `handleResume` 用例
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+4 — VM 实例状态同步闭环
- 控制平面在 WS 连接生命周期同步 `user_vm_instances`：
  - 认证成功后标记 `ready`
  - 心跳更新 `last_heartbeat_at`
  - 断线/心跳超时标记 `disconnected`
- 关键实现：`apps/api/src/ws/ws-server.ts`（`markVMInstanceState` / `touchHeartbeat`）
- 验证通过：
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`

### 2026-02-22 迭代 X+5 — OpenClaw Bridge 骨架落地
- `runtime/src/session/openclaw_adapter.py` 从占位实现升级为真实桥接：
  - 启动子进程（`OPENCLAW_BRIDGE_CMD` 可覆盖）
  - JSONL stdin/stdout IPC（start/user_message/cancel/stop）
  - 桥接事件转发到控制平面 SSE
  - bridge 异常退出统一上报 `OPENCLAW_BRIDGE_EXITED`
- 新增 OpenClaw Bridge Node 骨架：
  - `runtime/openclaw-bridge/package.json`
  - `runtime/openclaw-bridge/tsconfig.json`
  - `runtime/openclaw-bridge/src/main.ts`
  - `runtime/openclaw-bridge/src/bridge.ts`
  - `runtime/openclaw-bridge/src/event-translator.ts`
  - `runtime/openclaw-bridge/src/skill-loader.ts`
- 新增测试：`runtime/tests/session/test_openclaw_adapter.py`
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+6 — OpenClaw 控制平面代理往返打通
- `OpenClawBridgeAdapter` 新增 bridge→adapter `cp_request` 处理：
  - bridge 发起 `cp_request(id, method, params)`
  - adapter 调用 `client.request(session_id, method, **params)`
  - adapter 回写 `cp_response(id, result/error)` 到 bridge stdin
- `runtime/openclaw-bridge/src/bridge.ts` 新增 mock 控制平面调用链：
  - `user_message` 时发送 `cp_request(memory_search)`
  - 收到 `cp_response` 后输出 `text` + `execution_complete`
  - 失败输出 `execution_error`
- 测试增强：`runtime/tests/session/test_openclaw_adapter.py`
  - 新增 `cp_request` 场景断言（调用 client.request + 回写 cp_response）
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+7 — OpenClaw start payload 规整
- `OpenClawBridgeAdapter` 新增 `_start_payload_for_bridge()`：
  - 仅转发 bridge 需要的白名单字段（agent/runtime/mcp/skills/session/openclaw 配置）
  - 避免把无关上下文直接透传到 bridge 进程
- 测试更新：`runtime/tests/session/test_openclaw_adapter.py`
  - 断言 `start` 指令 payload 包含 `runtime_type`
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+8 — OpenClaw Bridge 事件/技能/上报增强
- `openclaw_adapter` 新增 bridge 消息类型支持：
  - `cp_fire_and_forget` → `client.fire_and_forget(...)`
  - 异常时上报 `CP_FIRE_AND_FORGET_FAILED`
- `runtime/openclaw-bridge/src/event-translator.ts` 增加 `translateOpenClawEvent()`：
  - `reasoning/assistant_message/tool_started/tool_finished/done/error` → Semibot SSE 事件
- `runtime/openclaw-bridge/src/skill-loader.ts` 从占位升级为可用组件：
  - 支持从 `skill_index` 初始化
  - 跟踪待加载 skill
  - 缓存已加载 package
- `runtime/openclaw-bridge/src/bridge.ts` 增强：
  - `start` 后自动发 `get_skill_package` 预加载请求
  - `user_message` 发 `memory_search` 请求
  - `cp_response` 后输出文本与完成事件
  - 同步发 `cp_fire_and_forget`（`audit_log` + `usage_report`）
- 测试增强：`runtime/tests/session/test_openclaw_adapter.py`
  - 新增 `cp_fire_and_forget` 场景
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py -q`
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+9 — OpenClawRunner 抽象与桥接入口
- 新增 `runtime/openclaw-bridge/src/openclaw-runner.ts`：
  - 抽象 `OpenClawRunner` 接口（`onStart/onUserMessage/onCancel`）
  - 实现 `MockOpenClawRunner`（控制平面 memory_search + fire_and_forget 上报）
  - 导出 `createOpenClawRunner()` 作为 bridge 的统一执行入口
- 重构 `runtime/openclaw-bridge/src/bridge.ts`：
  - 用 session 级 runtime 容器管理 `runner + skillLoader`
  - `cp_request/cp_response` 变为 Promise 请求-响应模型
  - `user_message` 逻辑迁移到 runner（bridge 只做 IO/路由）
  - 保留 `start` skill 预加载和 `cancel/stop` 控制消息
  - 增加内部异常保护（`OPENCLAW_BRIDGE_INTERNAL_ERROR`）
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+10 — Runner 模式切换占位
- `runtime/openclaw-bridge/src/openclaw-runner.ts` 增加 `SdkOpenClawRunner` 占位实现
- `createOpenClawRunner()` 支持 `OPENCLAW_RUNNER_MODE` 环境变量：
  - `mock`（默认）
  - `sdk`（占位，当前返回未实现错误事件）
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py -q`

### 2026-02-22 迭代 X+11 — SdkOpenClawRunner 最小可运行链路
- 新增 `runtime/openclaw-bridge/src/sdk-provider.ts`
  - `OpenClawSdkProvider` 抽象
  - `CommandSdkProvider`（`OPENCLAW_SDK_CMD`，stdin 输入 JSON，stdout 输出文本/JSON）
  - `FallbackSdkProvider`（无外部命令时的内置占位生成）
- `runtime/openclaw-bridge/src/openclaw-runner.ts` 中 `SdkOpenClawRunner` 升级：
  - `onStart` 读取 `agent_config.model` 与 `openclaw_config.tool_profile`
  - `onUserMessage`：先 `memory_search`，再调用 sdk provider 生成回复
  - 回传 `assistant_message` + `done`
  - 上报 `audit_log` / `usage_report`
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py -q`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+12 — OpenClaw Bridge 协议收敛与 E2E
- 新增协议模块：`runtime/openclaw-bridge/src/protocol.ts`
  - 统一 bridge 入站命令 schema（`parseBridgeCommand`）
  - 固定 SDK 命令输入/输出 schema（snake_case）
  - 统一 SDK 输出解析（JSON/text 双模式）
- bridge / sdk-provider 接入统一协议：
  - `runtime/openclaw-bridge/src/bridge.ts` 使用 `parseBridgeCommand`
  - `runtime/openclaw-bridge/src/sdk-provider.ts` 使用 `toSdkCommandInput` / `parseSdkCommandOutput`
- 修复协议路由缺陷：
  - `cp_response` 无 `session_id` 时不再被 bridge 丢弃（符合 WS 协议）
- 新增 bridge 端到端测试：
  - `runtime/openclaw-bridge/tests/bridge-e2e.mjs`
  - 覆盖 `start -> get_skill_package -> user_message -> memory_search -> cp_fire_and_forget -> execution_complete`
  - `runtime/openclaw-bridge/package.json` 新增 `test:e2e` 脚本
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm -C runtime/openclaw-bridge run test:e2e`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+13 — SDK 命令协议文档化与 SDK E2E
- 新增文档：`runtime/openclaw-bridge/PROTOCOL.md`
  - bridge stdin/stderr 协议
  - `OPENCLAW_SDK_CMD` 输入输出 schema
  - 错误处理约定
- 新增 SDK 模式 E2E：`runtime/openclaw-bridge/tests/bridge-sdk-e2e.mjs`
  - `OPENCLAW_RUNNER_MODE=sdk`
  - 注入 `OPENCLAW_SDK_CMD` mock 命令
  - 覆盖 `memory_search -> sdk output -> usage/audit -> execution_complete`
- 新增脚本：`runtime/openclaw-bridge/package.json`
  - `test:e2e:sdk`
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm -C runtime/openclaw-bridge run test:e2e`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+14 — SDK 错误码细化与失败 E2E
- `runtime/openclaw-bridge/src/sdk-provider.ts`
  - 新增 `SdkProviderError`
  - 细化错误码：
    - `SDK_COMMAND_SPAWN_FAILED`
    - `SDK_COMMAND_TIMEOUT`
    - `SDK_COMMAND_FAILED`
    - `SDK_OUTPUT_INVALID`
  - 支持 `OPENCLAW_SDK_TIMEOUT_MS`（默认 15000ms）
- `runtime/openclaw-bridge/src/openclaw-runner.ts`
  - `SdkOpenClawRunner` 捕获并透传 `SdkProviderError` 到 `execution_error.code`
  - 增加兼容分支（duck-typing）避免跨模块实例判断失效
- `runtime/openclaw-bridge/src/event-translator.ts`
  - `OpenClawEvent` 增加 `error_code`
  - `error` 事件优先使用 `event.error_code`
- 新增失败路径 E2E：
  - `runtime/openclaw-bridge/tests/bridge-sdk-fail-e2e.mjs`
  - `runtime/openclaw-bridge/package.json` 新增 `test:e2e:sdk:fail`
- 文档更新：
  - `runtime/openclaw-bridge/PROTOCOL.md` 增加 SDK 错误码约定
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm -C runtime/openclaw-bridge run test:e2e`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk:fail`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+15 — SDK 错误码覆盖完善（timeout/invalid）
- 新增 SDK 失败覆盖 E2E：
  - `runtime/openclaw-bridge/tests/bridge-sdk-timeout-e2e.mjs` → 断言 `SDK_COMMAND_TIMEOUT`
  - `runtime/openclaw-bridge/tests/bridge-sdk-invalid-output-e2e.mjs` → 断言 `SDK_OUTPUT_INVALID`
- `runtime/openclaw-bridge/package.json` 新增脚本：
  - `test:e2e:sdk:timeout`
  - `test:e2e:sdk:invalid`
- 文档补充：
  - `runtime/openclaw-bridge/PROTOCOL.md` 说明 `OPENCLAW_SDK_TIMEOUT_MS` 默认值 `15000`
- 验证通过：
  - `pnpm -C runtime/openclaw-bridge exec tsc -p tsconfig.json`
  - `pnpm -C runtime/openclaw-bridge run test:e2e`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk:fail`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk:timeout`
  - `pnpm -C runtime/openclaw-bridge run test:e2e:sdk:invalid`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_openclaw_adapter.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+16 — SemiGraph 凭证下发闭环补强
- 控制平面 WS `init` 现在下发运行时可用 `api_keys`：
  - `apps/api/src/ws/ws-server.ts`
  - 来源：`process.env.OPENAI_API_KEY` / `process.env.ANTHROPIC_API_KEY`
- 新增握手测试：`apps/api/src/__tests__/ws.server.handshake.test.ts`
  - 认证通过后 `init.data.api_keys` 下发断言
  - 缺少 `user_id` 时拒绝连接断言
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/session/test_openclaw_adapter.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+17 — VM Scheduler 主流程接入 Chat
- 新增：`apps/api/src/scheduler/vm-scheduler.ts`
  - `ensureUserVM(userId, orgId, { wsReady })`：
    - 无活跃 VM：创建 `user_vm_instances` 记录（`starting`）
    - WS 已就绪：状态纠正为 `ready`
    - `disconnected`：触发重拉起并置为 `provisioning`
    - `failed/terminated`：重建实例
  - 支持 `VM_BOOTSTRAP_CMD`（可选）触发拉起命令，并注入 VM 上下文环境变量
- 改造：`apps/api/src/services/chat.service.ts`
  - chat 下发前先执行 `ensureUserVM`
  - VM 未就绪时返回明确状态：`执行平面未就绪（状态: xxx）`
- 新增测试：
  - `apps/api/src/__tests__/vm-scheduler.test.ts`
  - `apps/api/src/__tests__/chat-ws.integration.test.ts`（增加 scheduler 调用断言）
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+18 — VM 生命周期状态一致性修复
- 新增迁移：`database/migrations/016_user_vm_instances_lifecycle_columns.sql`
  - 为 `user_vm_instances` 增加：
    - `updated_at`
    - `last_heartbeat_at`
    - `disconnected_at`
  - 增加相关索引并做历史数据回填
- 修复 `apps/api/src/ws/ws-server.ts` 状态判定：
  - `hasActiveVMInstance` 支持 `starting/provisioning/running/ready/disconnected`
  - VM 状态更新 SQL 支持 `starting/provisioning`，避免首次连接无法从 `starting` 转 `ready`
  - 心跳更新时间支持 `starting/provisioning`
- 测试增强：`apps/api/src/__tests__/vm-scheduler.test.ts`
  - 新增 `starting + wsReady=true -> ready` 场景
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+19 — 本地 VM Bootstrap 模板与 Runbook
- 新增可执行脚本：`scripts/vm/bootstrap-local.sh`
  - 为 `VM_BOOTSTRAP_CMD` 提供本地拉起模板
  - 支持 pid/log 管理与幂等启动
  - 通过环境变量注入 runtime 启动参数（`VM_USER_ID/VM_TOKEN/...`）
- 新增文档：`docs/design/execution-plane-arch/07-LOCAL-BOOTSTRAP.md`
  - 说明 scheduler 触发机制、脚本参数、建议本地接线
- 测试增强：`apps/api/src/__tests__/vm-scheduler.test.ts`
  - 校验 bootstrap spawn 参数与注入环境变量
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+20 — Scheduler 自动签发 VM_TOKEN
- `apps/api/src/scheduler/vm-scheduler.ts`
  - bootstrap 触发时自动签发 `VM_TOKEN`（JWT，10 分钟）
  - payload: `{ userId, orgId }`
  - 使用 `JWT_SECRET` 签名
- `apps/api/src/__tests__/vm-scheduler.test.ts`
  - 新增对 `VM_TOKEN` 的解签断言（校验 `userId/orgId`）
- 文档更新：
  - `docs/design/execution-plane-arch/07-LOCAL-BOOTSTRAP.md`
  - 明确 `VM_TOKEN` 由 scheduler 自动注入
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+21 — 自动执行 10 步（调度稳态 + 运维）
1. `vm-scheduler` 增加 bootstrap 元数据字段读取：`last_bootstrap_at/bootstrap_attempts`
2. 新实例创建写入 `bootstrap_attempts=0`
3. 增加默认 bootstrap 命令解析：
   - 非生产环境且 `scripts/vm/bootstrap-local.sh` 存在时自动启用
4. 增加 bootstrap 冷却策略：`VM_BOOTSTRAP_COOLDOWN_MS`（默认 30000）
5. 增加 bootstrap 触发计数与时间戳更新：`touchBootstrapAttempt`
6. 断线 VM 在冷却窗口内不重复拉起，避免风暴
7. 新增迁移：`database/migrations/017_user_vm_instances_bootstrap_attempts.sql`
8. 单测增强：`vm-scheduler.test.ts` 增加 cooldown 跳过场景
9. 新增运维脚本：`scripts/vm/stop-local.sh`
10. 新增运维脚本：`scripts/vm/status-local.sh`
- 文档更新：
  - `docs/design/execution-plane-arch/07-LOCAL-BOOTSTRAP.md`
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `bash -n scripts/vm/bootstrap-local.sh scripts/vm/status-local.sh scripts/vm/stop-local.sh`

### 2026-02-22 迭代 X+22 — 自动执行 10 步（Bootstrap 强化）
1. `vm-scheduler` 新增 bootstrap 元字段：`bootstrap_last_error`
2. 新增失败错误落库逻辑：`recordBootstrapFailure`
3. 新实例拉起成功时状态直接推进到 `provisioning`
4. 断线恢复增加尝试次数上限：`VM_BOOTSTRAP_MAX_ATTEMPTS`（默认 5）
5. 超过上限自动标记 `failed`，并记录失败原因
6. 保留 cooldown 防抖策略并与上限策略组合
7. 新增迁移：`database/migrations/018_user_vm_instances_bootstrap_error.sql`
8. 扩展 `vm-scheduler.test.ts`：新增 provisioning 启动路径断言
9. 扩展 `vm-scheduler.test.ts`：新增 attempts exceeded -> failed 断言
10. 更新 runbook：`07-LOCAL-BOOTSTRAP.md` 增加 `VM_BOOTSTRAP_MAX_ATTEMPTS`
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+23 — 自动执行 10 步（调度可观测与控制）
1. `ensureUserVM` 返回 `retryAfterMs`，用于上层重试提示
2. `chat.service.ts` 在 VM 未就绪错误中增加秒级重试建议
3. scheduler 新增 `getUserVMStatus(userId)` 查询接口
4. scheduler 新增 `forceRebootstrap(userId, orgId)` 强制重拉起接口
5. 新增路由：`apps/api/src/routes/v1/vm.ts`
   - `GET /api/v1/vm/status`
   - `POST /api/v1/vm/rebootstrap`
6. `routes/v1/index.ts` 挂载 `/vm`
7. scheduler 新增 bootstrap 失败持久化字段：`bootstrap_last_error`
8. 新增迁移：`database/migrations/018_user_vm_instances_bootstrap_error.sql`
9. 单测增强：`vm-scheduler` 增加 retryAfterMs/cooldown/attempts 上限相关断言
10. 新增路由导出测试：`apps/api/src/__tests__/vm.route.test.ts`
- 文档更新：
  - `docs/design/execution-plane-arch/07-LOCAL-BOOTSTRAP.md` 增加 `VM_BOOTSTRAP_MAX_ATTEMPTS`
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/vm.route.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+24 — 自动执行 10 步（状态与重试策略完善）
1. `ensureUserVM` 支持返回 `retryAfterMs`
2. `chat.service.ts` 将 `retryAfterMs` 映射为“建议 N 秒后重试”提示
3. `forceRebootstrap` 明确绕过 cooldown（`force=true`）
4. `getUserVMStatus` 返回 `retryAfterMs`
5. scheduler 新增 `bootstrap_last_error` 字段读取与返回
6. disconnected 状态增加尝试上限保护并可标记 failed
7. 新增迁移：`database/migrations/019_user_vm_instances_bootstrap_indexes.sql`
8. 新增本地运维脚本：`scripts/vm/rebootstrap-local.sh`
9. runbook 增补 VM 状态控制 API：`/api/v1/vm/status`、`/api/v1/vm/rebootstrap`
10. 测试增强：`vm-scheduler.test.ts` 新增 force bypass cooldown 与 status retryAfterMs 用例
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/vm.route.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py -q`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `bash -n scripts/vm/bootstrap-local.sh scripts/vm/status-local.sh scripts/vm/stop-local.sh scripts/vm/rebootstrap-local.sh`

### 2026-02-22 迭代 X+25 — 自动执行（SemiGraph checkpoint 闭环）
1. 升级 `runtime/src/checkpoint/local_checkpointer.py` 为 session 目录结构：`.semibot/sessions/{session_id}/checkpoints/*.json`
2. 增加 checkpoint 保留策略（默认保留最近 10 个）
3. 增加 `load_latest` 与 `get_all_for_snapshot` 能力
4. `SemiGraphAdapter` 切换为 session 根目录：`.semibot/sessions/{session_id}`
5. `SemiGraphAdapter` 接入 `LocalCheckpointer`，执行完成/失败/取消均落盘 checkpoint
6. `SemiGraphAdapter` 追加 `snapshot_sync` 上报（best-effort）
7. `SemiGraphAdapter` 在缺省 history 场景下从最近 checkpoint 恢复历史
8. 取消流程补齐 checkpoint+snapshot，避免早取消丢快照
9. 强化单测：`test_semigraph_adapter_ws.py` 增加 checkpoint 落盘、snapshot_sync、history 恢复断言
10. 修复 API 路由行为测试，移除 `supertest` 依赖改为直接调用路由 handler
- 验证通过：
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/vm.route.behavior.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/relay.sse-relay.test.ts`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `cd runtime && .venv/bin/python -m compileall src`

### 2026-02-22 迭代 X+26 — 自动执行（旧 HTTP runtime 残留清理）
1. 删除 API 侧旧 `runtime HTTP adapter`：`apps/api/src/adapters/runtime.adapter.ts`
2. 删除其测试：`apps/api/src/__tests__/runtime.adapter.test.ts`
3. 删除未挂载的 legacy runtime 监控路由：`apps/api/src/routes/v1/runtime.ts`
4. 删除 legacy runtime 监控服务：`apps/api/src/services/runtime-monitor.service.ts`
5. 删除 legacy 监控/回退集成测试：`apps/api/src/__tests__/chat-runtime.integration.test.ts`
6. 清理 `config.ts` 中仅供旧 HTTP adapter 使用的 runtime 常量
7. 移除 `RUNTIME_SERVICE_URL` 启动日志噪声
8. 全库检索确认无 runtime.adapter/runtime-monitor 残留引用
9. API TypeScript 编译校验通过
10. 执行平面关键测试（API + runtime）回归通过
- 验证通过：
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/chat-ws.integration.test.ts src/__tests__/vm-scheduler.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/relay.sse-relay.test.ts src/__tests__/vm.route.behavior.test.ts`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`

### 2026-02-22 迭代 X+27 — 自动执行（runtime 去耦：server 依赖剥离）
1. 新增通用 MCP 启动模块：`runtime/src/mcp/bootstrap.py`
2. 将 MCP 连接逻辑从 `server/routes.py` 抽离到 `mcp/bootstrap.py`
3. `SubAgentDelegator` 改为直接调用 `setup_mcp_client`，移除对 `src.server.routes/models` 的依赖
4. `test_delegator.py` patch 路径更新为 `src.agents.delegator.setup_mcp_client`
5. 新增 `runtime/src/ws/event_emitter.py`（execution-plane 中立事件发射器）
6. `SemiGraphAdapter` 与 `server/routes.py` 都切换到 `src.ws.event_emitter`
7. 删除旧 `runtime/src/server/event_emitter.py`
8. 新增 `runtime/src/storage/file_manager.py`，将文件持久化能力迁移到中立模块
9. `code_executor.py` 与 `server/app.py` 改为引用 `src.storage.file_manager`
10. 删除旧 `runtime/src/server/file_manager.py`
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/memory/test_app_integration.py tests/agents/test_delegator.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`

### 2026-02-22 迭代 X+28 — 自动执行（无兼容化收敛）
1. `runtime/src/server/models.py` 文档注释去除对已删除 `runtime.adapter.ts` 的引用
2. `orchestrator/act_node` 去掉 legacy executor fallback 描述，明确仅支持 `UnifiedActionExecutor`
3. `act_node` 逻辑删除 `action_executor` 分支与 capability-graph 兼容路径
4. `act_node` 保留并强化统一执行策略：并行+顺序混合，search→code_executor 时强制顺序
5. 清理 `nodes.py` 中已废弃的 `execute_parallel/execute_single` 导入
6. 新增中立模块 `runtime/src/mcp/bootstrap.py`（MCP 连接抽象）
7. `SubAgentDelegator` 改用中立 MCP 抽象，不再依赖 `server.routes/models`
8. 新增中立模块 `runtime/src/ws/event_emitter.py` 并替换引用
9. 新增中立模块 `runtime/src/storage/file_manager.py`，替换 `code_executor` 与 `server/app` 引用
10. 删除 server 包中的已迁移组件：`event_emitter.py`、`file_manager.py`
- 验证通过：
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/orchestrator/test_nodes_memory.py tests/agents/test_delegator.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/memory/test_app_integration.py tests/agents/test_delegator.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `cd runtime && .venv/bin/python -m compileall src`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/chat-ws.integration.test.ts src/__tests__/vm-scheduler.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/relay.sse-relay.test.ts src/__tests__/vm.route.behavior.test.ts`

### 2026-02-22 迭代 X+29 — 自动执行（彻底下线 runtime HTTP server）
1. `runtime/main.py` 入口改为 execution-plane 模式：调用 `src.main.main()`
2. `runtime/package.json` dev 脚本改为 `python -m src.main`
3. 删除 runtime HTTP server 代码：`runtime/src/server/app.py`
4. 删除 runtime HTTP server 代码：`runtime/src/server/routes.py`
5. 删除 runtime HTTP server 代码：`runtime/src/server/models.py`
6. 删除 runtime HTTP server 代码：`runtime/src/server/middleware.py`
7. 删除 runtime HTTP server 代码：`runtime/src/server/errors.py`
8. 删除 runtime HTTP server 包入口：`runtime/src/server/__init__.py`
9. 删除仅服务于 HTTP server 的测试：`runtime/tests/memory/test_app_integration.py`
10. 更新 `runtime/README.md`，移除 uvicorn/FastAPI 运行与依赖说明，新增 `python -m src.main`
- 验证通过：
  - `cd runtime && .venv/bin/python -m compileall src`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/orchestrator/test_nodes_memory.py tests/agents/test_delegator.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/chat-ws.integration.test.ts src/__tests__/vm-scheduler.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/relay.sse-relay.test.ts src/__tests__/vm.route.behavior.test.ts`

### 2026-02-22 迭代 X+30 — 自动执行（依赖与文档收尾）
1. `runtime/requirements.txt` 移除已下线 HTTP server 依赖：`fastapi`、`uvicorn`、`sse-starlette`
2. `runtime/requirements.txt` 移除未使用依赖：`aiohttp`
3. `runtime/pyproject.toml` 移除未使用依赖：`python-multipart`
4. 更新 `docs/runtime/chat-runtime-implementation-summary.md` 启动命令为 `python -m src.main`
5. 更新 `docs/runtime/chat-runtime-verification-checklist.md` 的测试项与启动命令
6. 更新 `docs/runtime/chat-runtime-cutover.md` 的测试项与运行命令
7. 更新 `docs/runtime/runtime-observability.md` 中进程检查命令，去除 uvicorn worker 建议
8. 回归验证通过：runtime 关键测试（43 项）
9. 回归验证通过：API TypeScript 编译
10. 回归验证通过：API 执行平面关键用例（27 项）
- 验证命令：
  - `cd runtime && .venv/bin/python -m compileall src`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/orchestrator/test_nodes_memory.py tests/agents/test_delegator.py tests/session/test_semigraph_adapter_ws.py tests/ws/test_client_reconnect.py`
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/chat-ws.integration.test.ts src/__tests__/vm-scheduler.test.ts src/__tests__/ws.server.handshake.test.ts src/__tests__/ws.message-router.test.ts src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/relay.sse-relay.test.ts src/__tests__/vm.route.behavior.test.ts`

### 2026-02-23 迭代 X+31 — 审查报告问题修复（高优先级批次）
1. 修复 `chat.service.ts` 取消条件反转：`res.on('close')` 改为 `connection.isActive` 时下发 cancel
2. 修复 `ws-server.ts` 完成事件名：`done` -> `execution_complete`
3. 修复 `semigraph_adapter.py` 取消事件语义：`execution_error` -> `execution_complete + cancelled=true`
4. 修复 `ws-server.ts` JSON 解析健壮性：`handleMessage` 增加 try/catch，非法 JSON 忽略并记录日志
5. 修复 `vm-scheduler.ts` 死代码：移除 `active.status === 'terminated'` 分支
6. 修复 JWT 弱密钥 fallback 风险：生产环境缺失 `JWT_SECRET` 时抛错（scheduler/ws-server）
7. 实现 VM 一次性 ticket 校验：
   - 调度侧每次 bootstrap 轮换 `connect_ticket` 并注入 `VM_TICKET`
   - 控制平面握手时消费 ticket（首次连接）或校验已消费状态（重连）
   - 新增迁移 `020_user_vm_instances_connect_ticket.sql`
8. 实现长期记忆写入链路：
   - runtime `WSMemoryProxy.save_long_term` 改为 `fire_and_forget(memory_write)`
   - control-plane `ws-server` 新增 `memory_write` 处理并写入 `memories`
9. 实现 session snapshot 保留策略：`snapshot_sync` 后保留最近 3 条，删除旧快照
10. 实现 Skill 依赖检查：`SessionManager.start_session` 过滤不满足 `requires.binaries/env_vars` 的 skill
11. 实现 skill metadata 非硬编码：`chat.service.ts` 从 package metadata/文件系统推导 `file_inventory` 与 `requires`
12. 修正文档环境变量偏差：`04-EXECUTION-PLANE.md` 中 `USER_ID` -> `VM_USER_ID`
13. 新增测试：
   - `apps/api/src/__tests__/ws.server.request-fireforget.test.ts` 增加非法 JSON 忽略用例
   - `runtime/tests/session/test_session_manager_requirements.py` 覆盖 skill requirement 过滤
   - 更新 `runtime/tests/session/test_semigraph_adapter_ws.py` 取消事件断言
- 验证通过：
  - `pnpm --filter @semibot/api exec tsc --noEmit`
  - `pnpm --filter @semibot/api exec vitest --run src/__tests__/ws.server.request-fireforget.test.ts src/__tests__/vm-scheduler.test.ts src/__tests__/chat-ws.integration.test.ts src/__tests__/ws.server.handshake.test.ts`
  - `cd runtime && PYTHONPATH=. .venv/bin/pytest -q tests/session/test_semigraph_adapter_ws.py tests/session/test_session_manager_requirements.py tests/ws/test_client_reconnect.py tests/agents/test_delegator.py`
