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

旧路径（legacy）：
  前端 → API → HTTP POST /api/v1/execute/stream → Runtime（单进程）→ SSE → 前端

新路径（new）：
  前端 → 控制平面 → WebSocket → 执行平面（per-user VM（多 session 共享））→ SSE → 前端

切换方式：
  user.execution_mode = 'legacy' | 'new'
  org.execution_mode = 'legacy' | 'new'   （组织级覆盖）
```

### 关键约束

- **绝不破坏现有系统** — 每个阶段只在现有代码旁边添加新能力，不修改已有行为
- **Feature Flag 控制切换** — 通过 `execution_mode` 字段决定走旧路径还是新路径
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

**目标：** 完整链路跑通：前端 → 控制平面 → WS → 执行平面（Docker 容器）→ LLM → 响应 → SSE → 前端。

#### 步骤

1. 实现 `apps/api/src/scheduler/vm-scheduler.ts`（先只支持 Docker 模式）

2. 改造 `chat.service.ts`，支持双模式分发：

```typescript
// apps/api/src/services/chat.service.ts
async handleChat(sessionId: string, message: string, userId: string, orgId: string) {
  const session = await sessionRepository.findById(sessionId);
  const user = await userRepository.findById(userId);

  if (user.executionMode === 'new') {
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

6. 端到端测试：创建 `execution_mode='new'` 的用户，发送消息，验证完整响应

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

将所有用户的 `execution_mode` 设为 `'legacy'`，旧路径立即接管。

---

### Phase 4：断线重连与容错（Resilience）

**目标：** 系统能优雅处理断线、崩溃和恢复。

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

Feature Flag 切回 `execution_mode='legacy'`。

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

- 新架构在生产环境稳定运行 2 周以上
- 无用户使用 `legacy` 模式
- 所有监控指标健康

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
    CHECK (status IN ('starting', 'running', 'frozen', 'terminated')),
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

-- organizations 表：添加组织级执行模式（优先级高于用户级）
-- 'legacy' = 旧 HTTP 路径，'new' = 新 WebSocket 路径
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'legacy';

-- users 表：添加用户级执行模式
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(20) DEFAULT 'legacy';

-- agents 表：添加默认执行模式
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS default_execution_mode VARCHAR(20) DEFAULT 'legacy';
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

### 集成测试

| 场景 | 验证内容 |
|------|----------|
| 控制平面 ↔ 执行平面 | 完整消息交换：init → user_message → sse_event → request/response |
| SSE 中继 | 前端 �� 控制平面 → WS → 执行平面 → 响应 → WS → SSE → 前端 |
| 断线重连 | kill WS 连接，验证自动重连和 resume 恢复 |
| Skill 懒加载 | 缓存未命中 → WS 拉取 → 缓存命中 |
| MCP 调用 | 远程 MCP 通过 WS 代理、本地 MCP 通过 STDIO 直连 |

### 端到端测试

| 场景 | 验证内容 |
|------|----------|
| Happy Path | 创建 session → 发送消息 → 接收流式响应 → 验证完整性 |
| 崩溃恢复 | 执行中 kill 执行平面 → 验证自动恢复 → 验证响应继续 |
| 并发隔离 | 10 个用户各运行多个 session，验证互不干扰 |
| 本地模式 | 本地执行平面连接 → 执行 → 断开，验证全流程 |

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
Phase 3: 端到端联调（E2E）
    │         依赖：Phase 1 + Phase 2
    ├─────────────────────┐
    ▼                     ▼
Phase 4: 断线重连与容错    Phase 5: 本地执行模式
（Resilience）            （Local）
    │  依赖：Phase 3       │  依赖：Phase 3（可与 Phase 4 并行）
    └─────────┬───────────┘
              ▼
Phase 6: 清理旧代码（Cleanup）
              依赖：Phase 4 + Phase 5
```

### 依赖关系

- Phase 2 依赖 Phase 1 — 需要 WS 服务端才能开发客户端
- Phase 3 依赖 Phase 1 + 2 — 需要两端都就绪才能联调
- Phase 4 依赖 Phase 3 — 需要端到端跑通后才能做容错
- Phase 5 可在 Phase 3 完成后启动，与 Phase 4 并行开发
- Phase 6 依赖 Phase 4 + 5 — 所有新功能稳定后才清理旧代码

---

## 7. 回滚方案

### 各阶段独立回滚

| 阶段 | 回滚方式 | 影响范围 |
|------|----------|----------|
| Phase 1-2 | 纯新增代码，不使用即可 | 无影响 |
| Phase 3-5 | Feature Flag `execution_mode='legacy'` 切回旧路径 | 新路径 session 需重新创建 |
| Phase 6 | `git revert` 恢复删除的文件 | 需重新部署 |

### 紧急回滚流程

当新路径出现严重问题时，按以下步骤在 5 分钟内恢复：

```
1. 数据库：将所有用户切回旧模式
   UPDATE users SET execution_mode = 'legacy' WHERE execution_mode = 'new';
   UPDATE organizations SET execution_mode = 'legacy' WHERE execution_mode = 'new';

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
