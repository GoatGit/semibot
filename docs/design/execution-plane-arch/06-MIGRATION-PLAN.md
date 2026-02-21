# 06 - 迁移计划

> 从现有单体架构分阶段迁移到 Web → 控制平面 → 执行平面三层架构的具体步骤、风险控制和回滚方案。

---

## 目录

1. [迁移策略](#1-迁移策略)
2. [迁移阶段](#2-迁移阶段)
3. [数据库迁移脚本](#3-数据库迁移脚本)
4. [风险矩阵](#4-风险矩阵)
5. [测试策略](#5-测试策略)
6. [时间线](#6-时间线)
7. [回滚方案](#7-回滚方案)

---

## 1. 迁移策略

### 核心原则

**渐进式迁移 + Feature Flag 双轨并行。** 新旧两条路径在迁移期间共存，每个阶段独立可部署、独立可回滚。

```
迁移期间的双轨架构：

旧路径（http）：
  前端 → API → HTTP POST /api/v1/execute/stream → Runtime（单进程）→ SSE → 前端

新路径（websocket）：
  前端 → 控制平面 → WebSocket → 执行平面（per-user VM（多 session 共享））→ SSE → 前端

切换方式（两个独立维度）：
  routing_mode = 'http' | 'websocket'     — 请求走哪条链路（迁移完成后废弃）
  vm_mode = 'firecracker' | 'docker' | 'local'  — VM 实际运行方式（长期保留）

  优先级：user > org > 系统默认
  字段映射：
    routing_mode: user.routing_mode > org.routing_mode > 系统默认('http')
    vm_mode:      user.vm_mode > agent.default_vm_mode > org.default_vm_mode > 系统默认('docker')
```

### 关键约束

- **绝不破坏现有系统** — 每个阶段只在现有代码旁边添加新能力，不修改已有行为
- **Feature Flag 控制切换** — 通过 `routing_mode` 字段决定走旧路径（HTTP）还是新路径（WebSocket），`vm_mode` 字段决定 VM 运行方式
- **独立可回滚** — 每个阶段都有明确的回滚步骤，最坏情况下可在 5 分钟内恢复
- **旧代码最后删除** — 只有在新路径稳定运行 2 周以上后，才清理旧代码

---

## 2. 迁移阶段

### Phase 1：控制平面 WebSocket 基础设施（Foundation）

**目标：** 在控制平面添加 WebSocket 服务端，不改动任何现有功能。

#### 步骤

1. 新增 `apps/api/src/ws/` 模块：
   - `ws-server.ts` — WebSocket 服务端
   - `vm-connection.ts` — 用户 VM 连接管理
   - `message-router.ts` — 消息路由（上行/下行）
   - `heartbeat.ts` — 心跳检测
2. 新增 WebSocket 端点：`/ws/vm`
3. 新增 `apps/api/src/relay/` 模块：
   - `sse-relay.ts` — SSE 缓冲转发
   - `sse-buffer.ts` — 环形缓冲区（从 `lib/` 升级）
4. 新增数据库表 `user_vm_instances`
5. 新增数据库表 `session_snapshots`
6. 新增数据库表 `usage_records`
7. 单元测试：WS 连接、消息路由、心跳超时、SSE 缓冲区

#### 变更范围

```
新增（不修改任何现有文件）：
├── apps/api/src/ws/
│   ├── ws-server.ts
│   ├── vm-connection.ts
│   ├── message-router.ts
│   └── heartbeat.ts
├── apps/api/src/relay/
│   ├── sse-relay.ts
│   └── sse-buffer.ts
├── apps/api/src/scheduler/        （空壳，Phase 3 填充）
└── database/migrations/
    └── 015_execution_plane_tables.sql
```

#### 风险评估

**低风险。** 纯新增代码，不修改任何现有文件，不影响现有行为。

#### 回滚

移除新增模块，`DROP` 新增数据库表。

---

### Phase 2：执行平面 WebSocket 客户端（Execution Plane Client）

**目标：** 在 Runtime 中添加 WebSocket 客户端，与现有 HTTP 服务器共存。

#### 步骤

1. 新增 `runtime/src/ws/` 模块：
   - `client.py` — 控制平面 WebSocket 客户端
   - `message_types.py` — 消息类型定义
2. 新增 `runtime/src/memory/local_memory.py` — 基于 MD 文件的短期记忆
3. 新增 `runtime/src/checkpoint/local_checkpointer.py` — 本地文件 checkpoint
4. 新增 `runtime/src/main.py` — VM 级守护进程入口（管理多 session 生命周期）
5. 新增 `runtime/src/session/manager.py` — Session 进程管理器（在 VM 内创建/销毁/路由 session）
6. Runtime 支持两种启动模式：
   - **旧模式**：`python -m server.app`（HTTP 服务器，现有行为不变）
   - **新模式**：`python -m main`（WS 客户端，连接控制平面，管理多 session）
7. 集成测试：执行平面连接控制平面，完成消息交换

#### 变更范围

```
新增（不修改任何现有文件）：
├── runtime/src/ws/
│   ├── client.py
│   └── message_types.py
├── runtime/src/memory/
│   └── local_memory.py          （与现有 short_term.py 并存）
├── runtime/src/checkpoint/
│   └── local_checkpointer.py
├── runtime/src/session/
│   └── manager.py               （Session 进程管理器）
└── runtime/src/main.py           （VM 级守护进程入口，旧入口 server/app.py 不变）
```

#### 风险评估

**低风险。** 新增入口文件，旧入口不受影响。

#### 回滚

不使用新入口即可。

---

### Phase 3：端到端联调 — Docker 模式（End-to-End with Docker）

**目标：** 完整链路跑通：前端 → 控制平面 → WS → 执行平面（Docker 容器，SemiGraph runtime）→ LLM → 响应 → SSE → 前端。

#### 步骤

1. 实现 `apps/api/src/scheduler/vm-scheduler.ts`（先只支持 Docker 模式）

2. 改造 `chat.service.ts`，支持双模式分发：

```typescript
// apps/api/src/services/chat.service.ts
async handleChat(sessionId: string, message: string, userId: string, orgId: string) {
  const session = await sessionRepository.findById(sessionId);
  const user = await userRepository.findById(userId);

  if (user.routingMode === 'websocket') {
    // 新路径：查找用户的 VM 连接，通过 WebSocket 下发给执行平面
    const vmConn = await wsServer.getOrStartVm(userId, orgId);
    vmConn.send({
      type: 'user_message',
      session_id: sessionId,
      data: { message, history },
    });
  } else {
    // 旧路径：HTTP POST 到 Runtime（现有逻辑不变）
    await runtimeAdapter.executeWithStreaming(connection, input);
  }
}
```

3. 改造 `orchestrator/nodes.py`，远程调用改为通过 WS 代理：
   - Skill 加载：`get_skill_files` via WS
   - 长期记忆：`memory_search` via WS
   - 远程 MCP：`mcp_call` via WS
   - 用量上报：`fire_and_forget` via WS
   - 审计日志：`fire_and_forget` via WS

4. 改造 `llm/base.py`，添加用量上报回调

5. 创建 Docker 镜像：`semibot/execution-plane`

6. 端到端测试：创建 `routing_mode='websocket'` 的用户，发送消息，验证完整响应

#### 变更范围

```
修改（首次改动现有代码，但在 Feature Flag 保护下）：
├── apps/api/src/services/chat.service.ts    → 添加 Feature Flag 分支
├── runtime/src/orchestrator/nodes.py        → 根据模式选择通信方式
├── runtime/src/llm/base.py                  → 添加 usage callback

新增：
├── apps/api/src/scheduler/vm-scheduler.ts
├── runtime/Dockerfile.execution-plane
└── docker-compose.execution-plane.yml
```

#### 风险评估

**中等风险。** 首次修改现有代码，但所有改动都在 Feature Flag 保护下，默认走旧路径。

#### 回滚

将所有用户的 `routing_mode` 设为 `'http'`，旧路径立即接管。

---

### Phase 3.5a：OpenClaw Bridge 骨架（Bridge Skeleton）

**目标：** 实现 RuntimeAdapter 抽象层、OpenClaw Bridge IPC 协议和事件翻译器，使用 mock OpenClaw 验证。

#### 步骤

1. 新增 `runtime/src/session/runtime_adapter.py` — RuntimeAdapter ABC
2. 新增 `runtime/src/session/semigraph_adapter.py` — 包装现有 SessionProcess，零改动
3. 新增 `runtime/src/session/openclaw_adapter.py` — OpenClaw Bridge 适配器
4. 改造 `runtime/src/session/manager.py` — SessionManager 根据 `runtime_type` 选择 Adapter
5. 新增 `runtime/openclaw-bridge/` — Node.js Bridge 进程骨架：
   - `src/main.ts` — 入口
   - `src/bridge.ts` — Unix Domain Socket IPC 服务端
   - `src/event-translator.ts` — OpenClaw → Semibot SSE 事件翻译
   - `src/skill-loader.ts` — Skill 缓存集成
6. IPC 协议实现（JSON-line，Unix Domain Socket）
7. 单元测试：mock OpenClaw 事件 → 验证翻译后的 SSE 事件格式正确
8. Adapter 单元测试：验证 SemiGraphAdapter 和 OpenClawBridgeAdapter 实现 RuntimeAdapter 接口

#### 变更范围

```
新增：
├── runtime/src/session/
│   ├── runtime_adapter.py       RuntimeAdapter ABC
│   ├── semigraph_adapter.py       包装现有 SessionProcess
│   └── openclaw_adapter.py      OpenClaw Bridge 适配器
├── runtime/openclaw-bridge/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── main.ts              入口
│       ├── bridge.ts            IPC 服务端
│       ├── event-translator.ts  事件格式翻译
│       └── skill-loader.ts      Skill 缓存集成

修改：
└── runtime/src/session/manager.py  → 添加 runtime_type 路由逻辑
```

#### 风险评估

**低风险。** SemiGraphAdapter 只是包装现有 SessionProcess，不改变任何现有行为。OpenClaw Bridge 是独立的 Node.js 进程。

#### 回滚

不使用 `runtime_type=openclaw` 即可，所有 session 默认走 SemiGraphAdapter（= 现有逻辑）。

---

### Phase 3.5b：OpenClaw E2E 集成（OpenClaw Integration）

**目标：** 接入真实 OpenClaw runtime，打通 Skill/Memory/MCP 全链路。

#### 步骤

1. Bridge 接入真实 OpenClaw Brain/Skills/Memory 模块
2. 实现 Skill 兼容：Bridge 重写 OpenClaw skill loader，优先从 `.semibot/skills/` 缓存读取，缓存未命中时通过 IPC → Python → WS 从控制平面拉取
3. 实现记忆兼容：
   - 短期记忆：OpenClaw 使用独立子目录（`openclaw-memory/`），互不干扰
   - 长期记忆：Bridge 代理 `memory_search` 请求，通过 IPC → Python → WS 到控制平面
4. 实现 MCP 代理：Bridge 代理远程 MCP 调用，通过 IPC → Python → WS 到控制平面
5. IPC 集成测试：Python ↔ Node.js Unix Socket 通信正确性
6. E2E 测试：创建 `runtime_type='openclaw'` 的 agent，发送消息，验证前端收到正确的 SSE 流
7. 并发测试：同一 VM 内同时运行 SemiGraph session 和 OpenClaw session，互不干扰

#### 变更范围

```
修改：
├── runtime/openclaw-bridge/src/   → 接入真实 OpenClaw
│   ├── bridge.ts                  → 完善 IPC 请求代理
│   ├── skill-loader.ts            → 接入 Semibot skill 缓存
│   └── event-translator.ts        → 完善事件映射

新增：
└── tests/
    ├── openclaw-ipc.test.ts       IPC 集成测试
    └── openclaw-e2e.test.ts       E2E 测试
```

#### 风险评估

**中等风险。** 涉及两个 runtime 的交互，但通过进程隔离限制了影响范围。

#### 回滚

将 `runtime_type` 切��� `semigraph`，OpenClaw session 不再创建。

---

### Phase 3.5c：双运行时 VM 镜像 + DB Migration + 前端 UI（Dual Runtime Release）

**目标：** 生产就绪的双运行时支持，包括 Docker 镜像、数据库变更和前端 runtime 选择 UI。

#### 步骤

1. 创建双运行时 Docker 镜像 `runtime/Dockerfile.dual`：
   - Stage 1: Python 3.12 + SemiGraph runtime（现有）
   - Stage 2: Node.js 20 + OpenClaw + Bridge
   - Stage 3: 合并，约 +160MB 内存 / +380MB 磁盘
2. 数据库迁移：
   ```sql
   ALTER TABLE agents ADD COLUMN runtime_type VARCHAR(20) DEFAULT 'semigraph';
   ALTER TABLE agents ADD COLUMN openclaw_config JSONB;
   ALTER TABLE sessions ADD COLUMN runtime_type VARCHAR(20);
   ALTER TABLE users ADD COLUMN default_runtime_type VARCHAR(20);
   ALTER TABLE organizations ADD COLUMN default_runtime_type VARCHAR(20);
   ```
3. 控制平面：`resolveRuntimeType()` 实现配置优先级链（session > agent > user > org > 系统默认）
4. 前端：Agent 设置页面添加 runtime 选择器（SemiGraph / OpenClaw）
5. 健康检查新增 `openclaw_available` 字段
6. VM 调度器：OpenClaw session 启用时建议 VM 内存从 512MB 提升到 768MB

#### 变更范围

```
新增：
├── runtime/Dockerfile.dual                双运行时镜像
└── database/migrations/
    └── 016_dual_runtime.sql               runtime_type 字段

修改：
├── apps/api/src/services/chat.service.ts  → resolveRuntimeType()
├── apps/api/src/ws/ws-server.ts           → sendStartSession 传递 runtime_type
├── apps/api/src/scheduler/vm-scheduler.ts → OpenClaw 内存配置
└── apps/web/.../agent-settings.tsx        → runtime 选择 UI
```

#### 风险评估

**中等风险。** 涉及数据库变更和前端改动，但 runtime_type 默认为 `semigraph`，不影响现有用户。

#### 回滚

数据库字段保留（有默认值），前端 UI 隐藏即可。

---

### Phase 4：断线重连与容错（Resilience）

**目标：** 系统能优雅处理断线、崩溃和恢复，覆盖两种 runtime。

#### 步骤

1. 实现 `ws/client.py` 重连协议（指数退避 + resume）
2. 实现 `ws-server.ts` 结果缓存（断线期间缓存 pending MCP 调用结果）
3. 实现 SSE 缓冲区重放（基于 `last_event_id` 的断点续传）
4. 实现 `vm-scheduler.ts` 健康检查循环
5. 实现快照同步（执行平面定期上传状态到控制平面）
6. 实现恢复流程：检测崩溃 → 分配新虚拟机 → 挂载卷 → 从 checkpoint 恢复
7. 压力测试：在 LLM 流式输出中、MCP 调用中、Skill 加载中分别 kill 执行平面
8. 前端：更新 `useSSE.ts` 处理 `resync` 事件

#### 变更范围

```
修改：
├── runtime/src/ws/client.py           → 添加重连逻辑
├── apps/api/src/ws/ws-server.ts       → 添加结果缓存、resume 处理
├── apps/api/src/relay/sse-relay.ts    → 添加缓冲区重放
├── apps/api/src/scheduler/vm-scheduler.ts → 添加健康检查、恢复流程
└── apps/web/.../useSSE.ts             → 添加 resync 处理
```

#### 风险评估

**中等风险。** 涉及复杂的状态管理，但改动集中在新增模块内，不影响旧路径。

#### 回滚

Feature Flag 切回 `routing_mode='http'`。

---

### Phase 5：本地执行模式（Local Execution）

**目标：** 用户可以在本地机器运行执行平面，连接云端控制平面。

#### 步骤

1. 将执行平面打包为可安装 CLI：`pip install semibot-runtime`
2. CLI 命令：
   ```bash
   # 指定用户连接
   semibot-runtime connect --user-id xxx --token yyy

   # 自动连接
   semibot-runtime connect --server wss://api.semibot.com --api-key sk-xxx
   ```
3. 前端：在 session 设置中添加"连接本地机器"选项
4. 控制平面：调度器支持 local 模式（等待 WS 连接而非分配虚拟机）
5. 编写安装指南和故障排查文档

#### 变更范围

```
新增/修改：
├── runtime/pyproject.toml              → 打包配置
├── runtime/src/cli.py                  → CLI 入口
├── apps/web/.../session-settings.tsx   → 本地连接 UI
└── apps/api/src/scheduler/vm-scheduler.ts → local 模式支持
```

#### 风险评估

**低风险。** 新增部署模式，不影响现有的云端模式。

#### 回滚

不使用本地模式即可。

---

### Phase 6：清理旧代码（Cleanup）

**目标：** 移除旧架构代码，简化系统。

#### 前置条件

- 新架构（`routing_mode='websocket'`）在生产环境稳定运行 2 周以上
- 无用户使用 `routing_mode='http'` 模式（灰度已 100% 切换）
- 所有监控指标健康（错误率、延迟、重连成功率均在阈值内）

#### 步骤

1. 删除 `apps/api/src/adapters/runtime.adapter.ts`（HTTP Runtime 通信）
2. 删除 `runtime/src/server/`（HTTP 服务器）
3. 删除 `runtime/src/queue/`（Redis Stream 消费者）
4. 删除 `runtime/src/memory/short_term.py`（Redis 短期记忆）
5. 删除 `runtime/src/memory/long_term.py`（已迁移至控制平面）
6. 删除 `runtime/src/memory/embedding.py`（已迁移至控制平面）
7. 删除 `runtime/src/evolution/`（已迁移至控制平面，仅保留 WS 提交接口）
8. 删除 `apps/api/src/services/runtime-monitor.service.ts`（已被 WS 心跳替代）
9. 删除 `apps/api/src/services/queue.service.ts`
10. 清理 `chat.service.ts` 中的 Feature Flag 和双模式分支
11. 清理 `orchestrator/nodes.py` 中的双模式分支
12. 删除旧配置常量（`RUNTIME_SERVICE_URL` 等）
13. 更新所有相关文档

#### 变更范围

删除约 15 个文件，简化 `chat.service.ts` 和 `nodes.py`。

#### 风险评估

**低风险**（前提是前置条件全部满足）。所有被删除的代码已经 2 周未被使用。

#### 回滚

`git revert` 恢复删除的文件。

---

## 3. 数据库迁移脚本

```sql
-- Migration: 015_execution_plane_tables.sql
-- 执行平面架构迁移 — 新增表和字段

-- ============================================================
-- 1. 用户虚拟机实例表（per-user 分配）
-- ============================================================
CREATE TABLE IF NOT EXISTS user_vm_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id UUID NOT NULL,
  mode VARCHAR(20) NOT NULL
    CHECK (mode IN ('firecracker', 'docker', 'local')),
  status VARCHAR(20) NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'running', 'frozen', 'failed', 'terminated')),
  vm_id VARCHAR(255),                -- 虚拟机/容器 ID
  disk_id VARCHAR(255),              -- 持久化磁盘 ID（用于崩溃恢复）
  ip_address VARCHAR(45),            -- 执行平面 IP 地址
  config JSONB DEFAULT '{}',         -- 资源配置（CPU、内存、网络）
  created_at TIMESTAMPTZ DEFAULT NOW(),
  terminated_at TIMESTAMPTZ
);

COMMENT ON TABLE user_vm_instances IS '用户虚拟机实例表 — 记录每个用户分配的执行环境（多 session 共享同一 VM）';
COMMENT ON COLUMN user_vm_instances.mode IS '执行模式：firecracker/docker/local';
COMMENT ON COLUMN user_vm_instances.status IS '实例状态：starting/running/frozen/terminated';
COMMENT ON COLUMN user_vm_instances.disk_id IS '持久化磁盘 ID，虚拟机崩溃后可挂载到新实例恢复数据';

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_user
  ON user_vm_instances(user_id);
CREATE INDEX IF NOT EXISTS idx_user_vm_instances_active
  ON user_vm_instances(status)
  WHERE status NOT IN ('terminated');

-- ============================================================
-- 2. Session 状态快照表（灾难恢复）
-- ============================================================
CREATE TABLE IF NOT EXISTS session_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  org_id UUID NOT NULL,
  checkpoint JSONB,                  -- LangGraph checkpoint 状态
  short_term_memory JSONB,           -- 短期记忆内容
  conversation_state JSONB,          -- 对话状态
  file_manifest JSONB,               -- 文件列表（不含文件内容）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE session_snapshots IS '执行平面状态快照 — 定期同步，用于灾难恢复';
COMMENT ON COLUMN session_snapshots.file_manifest IS '文件清单（仅路径和元数据，不含文件内容）';

CREATE INDEX IF NOT EXISTS idx_session_snapshots_session
  ON session_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_session_snapshots_latest
  ON session_snapshots(session_id, created_at DESC);

-- ============================================================
-- 3. 用量记录表（从内存/Redis 改为持久化）
-- ============================================================
CREATE TABLE IF NOT EXISTS usage_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  model VARCHAR(100),                -- LLM 模型名称
  tokens_in INTEGER DEFAULT 0,       -- 输入 token 数
  tokens_out INTEGER DEFAULT 0,      -- 输出 token 数
  latency_ms INTEGER,                -- 调用延迟（毫秒）
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE usage_records IS 'LLM 调用用量记录 — 用于计费和统计';

CREATE INDEX IF NOT EXISTS idx_usage_records_org
  ON usage_records(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_records_user
  ON usage_records(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_session
  ON usage_records(session_id);

-- ============================================================
-- 4. 现有表扩展
-- ============================================================

-- organizations 表：添加组织级路由模式
-- 'http' = 旧 HTTP 路径，'websocket' = 新 WebSocket 路径（迁移完成后废弃此字段）
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS routing_mode VARCHAR(20) DEFAULT 'http';

-- organizations 表：添加组织级 VM 运行模式（长期保留）
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_vm_mode VARCHAR(20) DEFAULT 'docker';

-- users 表：添加用户级路由模式（NULL = 继承组织级）
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS routing_mode VARCHAR(20);

-- users 表：添加用户级 VM 运行模式
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vm_mode VARCHAR(20);

-- agents 表：添加默认 VM 运行模式
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS default_vm_mode VARCHAR(20) DEFAULT 'docker';

-- user_vm_instances 表：每用户仅允许一个非终止状态的 VM（防御性约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_vm_one_active
  ON user_vm_instances(user_id)
  WHERE status NOT IN ('terminated', 'failed');

-- ============================================================
-- 5. 双运行时支持（Phase 3.5c）
-- ============================================================

-- agents 表：添加默认运行时类型
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_type VARCHAR(20) DEFAULT 'semigraph';
-- 'semigraph' | 'openclaw'

-- agents 表：添加 OpenClaw 特有配置
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS openclaw_config JSONB;

-- sessions 表：添加运行时类型（session 级覆盖）
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS runtime_type VARCHAR(20);

-- users 表：添加默认运行时偏好
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_runtime_type VARCHAR(20);

-- organizations 表：添加组织级默认运行时
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_runtime_type VARCHAR(20);
```

---

## 4. 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| WebSocket 连接在生产环境不稳定 | 中 | 高 | 完善的重连协议（指数退避 + resume）、SSE 缓冲区重放、checkpoint 恢复 |
| 性能退化（WS 开销 vs 直接 HTTP） | 低 | 中 | 迁移前后 benchmark 对比；WS 是持久连接，实际开销低于每次 HTTP 建连 |
| Docker 容器启动过慢 | 中 | 低 | 预热容器池；先用 Docker 验证，后续迁移到 Firecracker |
| 长时间 WS 连接内存泄漏 | 中 | 中 | 定期连接回收、内存监控告警、连接超时机制 |
| 执行平面崩溃导致数据丢失 | 低 | 高 | 每个状态转换写 checkpoint、定期快照同步到控制平面、鼓励用户 git push |
| 迁移期间双模式并存增加复杂度 | 高 | 低 | 清晰的 Feature Flag 设计、完善的测试覆盖、缩短迁移窗口期 |
| 本地执行平面安全风险（用户运行任意代码） | 低 | 中 | 用户级 JWT、控制平面数据只读访问、本地模式下用户对自己的机器负责 |
| OpenClaw Bridge 崩溃影响 VM 稳定性 | 低 | 中 | Bridge 作为独立进程运行，崩溃不影响其他 session；不做自动 fallback 到 SemiGraph |
| OpenClaw 版本升级导致事件格式变化 | 中 | 中 | event-translator 做版本适配，Bridge 启动时检测 OpenClaw 版本 |
| 双运行时 VM 内存不足 | 低 | 中 | OpenClaw 启用时自动提升 VM 内存到 768MB；监控内存使用率 |

---

## 5. 测试策略

### 单元测试

| 模块 | 测试内容 |
|------|----------|
| WS Server | 连接建立、JWT 认证、消息路由、心跳超时检测 |
| WS Client | 连接、重连、request/response 匹配、超时处理 |
| SSE Buffer | push、replay（断点续传）、溢出处理 |
| Local Memory | conversation 读写、context 读写、scratchpad 读写 |
| Local Checkpointer | put、get_latest、自动清理旧文件 |
| VM Scheduler | allocate、release、健康检查、恢复流程 |
| RuntimeAdapter | SemiGraphAdapter 和 OpenClawBridgeAdapter 接口一致性 |
| Event Translator | OpenClaw 事件 → Semibot SSE 事件格式映射正确性 |
| Bridge IPC | JSON-line 协议解析、Unix Domain Socket 通信 |

### 集成测试

| 场景 | 验证内容 |
|------|----------|
| 控制平面 ↔ 执行平面 | 完整消息交换：init → user_message → sse_event → request/response |
| SSE 中继 | 前端 → 控制平面 → WS → 执行平面 → 响应 → WS → SSE → 前端 |
| 断线重连 | kill WS 连接，验证自动重连和 resume 恢复 |
| Skill 懒加载 | 缓存未命中 → WS 拉取 → 缓存命中 |
| MCP 调用 | 远程 MCP 通过 WS 代理、本地 MCP 通过 STDIO 直连 |
| Python ↔ Node.js IPC | Unix Domain Socket JSON-line 通信正确性、错误处理 |
| OpenClaw Skill 加载 | Bridge 从 `.semibot/skills/` 缓存读取，缓存未命中时通过 IPC 拉取 |
| OpenClaw 记忆代理 | Bridge 代理 memory_search 请求到控制平面 |

### 端到端测试

| 场景 | 验证内容 |
|------|----------|
| Happy Path | 创建 session → 发送消息 → 接收流式响应 → 验证完整性 |
| 崩溃恢复 | 执行中 kill 执行平面 → 验证自动恢复 → 验证响应继续 |
| 并发隔离 | 10 个用户各运行多个 session，验证互不干扰 |
| 本地模式 | 本地执行平面连接 → 执行 → 断开，验证全流程 |
| OpenClaw Happy Path | 创建 `runtime_type='openclaw'` 的 agent → 发送消息 → 验证 SSE 事件格式正确 |
| 双运行时并发 | 同一 VM 内同时运行 SemiGraph session 和 OpenClaw session，互不干扰 |
| OpenClaw Bridge 崩溃 | kill Bridge 进程，验证不影响其他 session，错误正确上报 |

### 性能测试

| 指标 | 目标值 |
|------|--------|
| SSE 延迟（token 到屏幕） | 云端 < 50ms，本地 < 200ms |
| WS 吞吐量 | 负载下每秒消息数 |
| 容器启动时间 | 从 session 创建到首次响应 |
| 单用户虚拟机内存占用 | 基础 < 512MB |

---

## 6. 时间线

```
Phase 1: 控制平面 WS 基础设施（Foundation）
    │
    ▼
Phase 2: 执行平面 WS 客户端（Client）
    │         依赖：Phase 1（需要 WS 服务端才能连接）
    ▼
Phase 3: 端到端联调（E2E，SemiGraph only）
    │         依赖：Phase 1 + Phase 2
    ▼
Phase 3.5a: OpenClaw Bridge 骨架（IPC + Adapter + 事件翻译，mock OpenClaw）
    │         依赖：Phase 3（需要 SemiGraph 链路跑通）
    ▼
Phase 3.5b: OpenClaw E2E 集成（真实 OpenClaw，skill/memory/MCP 打通）
    │         依赖：Phase 3.5a
    ▼
Phase 3.5c: 双运行时 VM 镜像 + DB migration + 前端 runtime 选择 UI
    │         依赖：Phase 3.5b
    ├─────────────────────┐
    ▼                     ▼
Phase 4: 断线重连与容错    Phase 5: 本地执行模式
（Resilience，覆盖双 RT）  （Local）
    │  依赖：Phase 3.5c    │  依赖：Phase 3（可与 Phase 3.5/4 并行）
    └─────────┬───────────┘
              ▼
Phase 6: 清理旧代码（Cleanup）
              依赖：Phase 4 + Phase 5
```

### 依赖关系

- Phase 2 依赖 Phase 1 — 需要 WS 服务端才能开发客户端
- Phase 3 依赖 Phase 1 + 2 — 需要两端都就绪才能联调
- Phase 3.5a 依赖 Phase 3 — 需要 SemiGraph 链路跑通后才能开发 Bridge
- Phase 3.5b 依赖 Phase 3.5a — 需要 Bridge 骨架才能接入真实 OpenClaw
- Phase 3.5c 依赖 Phase 3.5b — 需要 E2E 验证通过才能发布
- Phase 4 依赖 Phase 3.5c — 容错需覆盖两种 runtime
- Phase 5 可在 Phase 3 完成后启动，与 Phase 3.5/4 并行开发
- Phase 6 依赖 Phase 4 + 5 — 所有新功能稳定后才清理旧代码

---

## 7. 回滚方案

### 各阶段独立回滚

| 阶段 | 回滚方式 | 影响范围 |
|------|----------|----------|
| Phase 1-2 | 纯新增代码，不使用即可 | 无影响 |
| Phase 3 | Feature Flag `routing_mode='http'` 切回旧路径 | 新路径 session 需重新创建 |
| Phase 3.5a-b | 不使用 `runtime_type=openclaw` 即可 | 仅影响 OpenClaw session |
| Phase 3.5c | 数据库字段保留（有默认值），前端 UI 隐藏 | 无影响 |
| Phase 4-5 | Feature Flag `routing_mode='http'` 切回旧路径 | 新路径 session 需重新创建 |
| Phase 6 | `git revert` 恢复删除的文件 | 需重新部署 |

### 紧急回滚流程

当新路径出现严重问题时，按以下步骤在 5 分钟内恢复：

```
1. 数据库：将所有用户切回旧模式
   UPDATE users SET routing_mode = 'http' WHERE routing_mode = 'websocket';
   UPDATE organizations SET routing_mode = 'http' WHERE routing_mode = 'websocket';

2. 重启 API 服务
   → 旧 HTTP Runtime 路径立即接管所有请求

3. 验证
   → 确认前端聊天功能正常
   → 确认 SSE 流式输出正常

4. 事后处理
   → 排查新路径问题
   → 修复后逐步重新启用新路径
   → 先灰度 10% 用户，观察 24 小时
   → 逐步扩大到 50% → 100%
```

### 灰度发布策略

Phase 3 上线后，按以下节奏切换流量：

```
第 1 天：  内部测试用户使用新路径
第 3 天：  5% 新注册的用户使用新路径
第 5 天：  20% 用户
第 7 天：  50% 用户
第 10 天： 100% 用户
第 14 天： 确认稳定，进入 Phase 6 清理旧代码
```

灰度期间监控指标：
- SSE 延迟 P99
- WS 重连次数
- 执行平面崩溃率
- 用户报错率
- LLM 调用成功率
