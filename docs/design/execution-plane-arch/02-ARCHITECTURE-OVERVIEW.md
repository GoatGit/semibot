# 02 - 架构总览

## 1. 三层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         Web 前端                                  │
│                    Next.js + React                                │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 聊天界面  │  │ Agent 管理│  │ 技能市场  │  │ 系统设置  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTPS + SSE
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                       控制平面 (云端固定)                          │
│                    Express + TypeScript                           │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Session  │  │ Agent/   │  │ 长期记忆  │  │ 审计/    │        │
│  │ 调度器   │  │ 技能管理  │  │ pgvector │  │ 计费     │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ 远程 MCP │  │ 进化技能  │  │ OAuth/   │  │ SSE      │        │
│  │ 连接池   │  │ 治理     │  │ Key 管理  │  │ 缓冲转发  │        │
│  └───���──────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
│  PostgreSQL + Redis                                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │ WebSocket (统一协议)
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                  执行平面 (每用户一个虚拟机)                        │
│                    Python + LangGraph                             │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ Session  │  │ 短期记忆  │  │ 文件系统  │  │ 代码执行  │        │
│  │ 进程管理  │  │ (MD文件)  │  │ (共享)   │  │ (直接)   │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐        │
│  │ LangGraph��  │ 本地 MCP │  │ LLM 直连  │  │Checkpoint│        │
│  │ 编排器   │  │ (STDIO)  │  │ Provider │  │ 本地存储  │        │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘        │
│                                                                  │
│  部署形态：Firecracker 虚拟机 / Docker 容器 / 用户本地机器          │
│  每用户一个实例，多 session 作为独立进程共享文件系统                  │
└──────────────────────────────────────────────────────────────────┘
```

## 2. 核心设计原则

### 2.1 统一通信：一条 WebSocket 连接一切

不区分云端虚拟机、本地机器、localhost，每个用户的执行平面通过一条 WebSocket 反向连接控制平面，多 session 消息通过 session_id 多路复用：

```
用户 A 的云端虚拟机  ──── ws://10.0.1.100:8080  ────→ 控制平面
  ├── session-1 的消息带 session_id
  ├── session-2 的消息带 session_id
  └── session-3 的消息带 session_id

用户 B 的本地机器    ──── wss://api.semibot.com  ────→ 控制平面
  ├── session-4 的消息带 session_id
  └── session-5 的消息带 session_id
```

所有通信（SSE 转发、MCP 调用、技能拉取、记忆检索、审计上报）都走这一条 WebSocket，按 session_id 区分。

### 2.2 Runtime 一分为二

现有 Runtime 的模块按职责拆分到两个平面：

```
                    现有 Runtime
                        │
          ┌─────────────┼─────────────┐
          ▼                           ▼
     控制平面（管理）            执行平面（运行，每用户一个）
     ├── Skill Registry        ├── Session 进程管理
     ├── Evolution Engine      ├── LangGraph 编排器
     ├── 长期记忆 (pgvector)    ├── 短期记忆 (MD)
     ├── 远程 MCP 连接池        ├── 文件系统（用户共享）
     ├── Agent 定义管理         ├── 代码执行 (直接)
     ├── 审计/计费             ├── 本地 MCP (STDIO)
     └── Session 调度          ├── LLM 直连
                               └── Checkpoint
```

### 2.3 LLM 直连

执行平面直连 LLM Provider，不经过控制平面：

```
执行平面 ──→ OpenAI / Anthropic / ...
              │
              │ SSE 流式输出
              ▼
执行平面 ──→ (通过 WebSocket) ──→ 控制平面 ──→ (SSE) ──→ 前端
```

API Key 由控制平面在 session 启动时注入执行平面内存，不落盘，session 结束后擦除。

### 2.4 技能分层

```
控制平面 = 技能仓库                执行平面 = 技能运行时
├── SkillDefinition 元数据         ├── SKILL.md 文件（懒加载）
├── SkillPackage 版本管理          ├── 技能执行上下文
├── Agent-Skill 绑定关系           └── 进化技能候选提交
├── 安装状态机 + 审计
├── 进化技能治理
└── 技能市场 / 语义搜索
```

类比 Docker：控制平面是 Docker Hub，执行平面是 Docker Host。

### 2.5 MCP 分治

```
远程 MCP（HTTP-SSE / Streamable HTTP）→ 控制平面共享连接池
  - 连接复用，省资源
  - OAuth token 集中管理
  - 限流/配额统一控制

本地 MCP（STDIO）→ 执行平面本地直连
  - 进程级通信，无法跨网络
  - 随 session 生灭

用户自带远程 MCP → 默认放执行平面，可选托管到控制平面
```

## 3. 数据流

### 3.1 用户发送消息

```
1. 前端 POST /api/v1/chat/sessions/{id}
   │
2. 控制平面收到消���
   ├── 保存 user message 到 PostgreSQL
   ├── 建立 SSE 连接给前端
   └── 通过 WebSocket 下发给执行平面
       │
3. 执行平面收到 user_message
   ├── LangGraph: START → PLAN
   │   └── LLM 直连 Provider（流式）
   │       └── thinking tokens 通过 WS 上行 → 控制平面 → SSE → 前端
   │
   ├── LangGraph: PLAN → ACT
   │   ├── 需要技能？ → WS 请求控制平面 get_skill_files → 懒加载
   │   ├── 需要远程 MCP？ → WS 请求控制平面 mcp_call → 连接池调用
   │   ├── 需要本地 MCP？ → 本地 STDIO 直连
   │   ├── 需要长期记忆？ → WS 请求控制平面 memory_search
   │   └── 代码执行 → 直接在执行平面运行（虚拟机本身即隔离）
   │
   ├── LangGraph: ACT → OBSERVE → (replan / continue / done)
   │
   ├── LangGraph: REFLECT
   │   ├── 短期记忆 → 写本地 MD 文件
   │   ├── 进化技能候选 → WS 上报控制平面 evolution_submit
   │   └── 审计日志 → WS 上报控制平面 audit_log
   │
   └── LangGraph: RESPOND
       └── response tokens 通过 WS 上行 → 控制平面 → SSE → 前端
           │
4. 控制平面收到 execution_complete
   ├── 保存 assistant message 到 PostgreSQL
   ├── 记录用量（tokens、延迟）
   └── SSE 发送 done 事件给前端
```

### 3.2 Session 生命周期

```
创建 Session
  │
  ├── 控制平面：
  │   ├── 创建 session 记录（PostgreSQL）
  │   ├── 查询 Agent 配置、绑定的技能、MCP Server
  │   ├── 检查用户是否已有虚拟机
  │   │   ├── 有 → 复用现有虚拟机，通过 WS 通知启动新 session 进程
  │   │   └── 无 → 分配新虚拟机（或等待本地连接）
  │   └── 准备初始化数据包（API Key、Agent 配置、技能索引）
  │
  ├── 执行平面（虚拟机内）：
  │   ├── 如果是新虚拟机：WebSocket 反向连接控制平面，启动心跳
  │   ├── 收到 start_session 指令
  │   ├── 启动新的 session 进程
  │   ├── 初始化 LangGraph 编排器
  │   └── 初始化短期记忆（session 元数据）
  │
  ├── 运行中：
  │   ├── 用户消息 → 控制平面 → WS(session_id) → 执行平面 → 对应 session 进程
  │   ├── LLM 输出 → session 进程 → WS(session_id) → 控制平面 → SSE → 前端
  │   ├── 定期状态快照 → 执行平面 → WS → 控制平面（备份）
  │   └── 心跳 → 执行平面 → WS → 控制平面（存活检测）
  │
  └── 结束 Session：
      ├── 执行平面：
      │   ├── 终止 session 进程
      │   ├── 清理 session 元数据（文件系统保留，属于用户个人电脑）
      │   └── WebSocket 保持连接（其他 session 可能还在运行）
      └── 控制平面：
          ├── 更新 session 状态为 completed
          ├── 如果用户无其他活跃 session → 虚拟机进入空闲冻结倒计时
          └── 最终审计记录
```

## 4. 部署模式

### 4.1 纯云端模式

```
适用：企业用户、团队协作、需要并发隔离

前端 ←── SSE ──── 控制平面 ←── WS ──── 用户 A 的虚拟机
                     │                   ├── session-1 进程
                 PostgreSQL              ├── session-2 进程
                 Redis                   └── 共享文件系统 + LLM 直连
```

- 控制平面按用户分配 Firecracker 虚拟机（一个用户一个）
- 同一用户的多个 session 共享虚拟机，作为独立进程运行
- 虚拟机在同一内网，WS 延迟 < 1ms
- 用户所有 session 结束后，虚拟机空闲冻结释放内存

### 4.2 本地执行模式

```
适用：个人开发者、隐私敏感场景、需要操作本地文件

前端 ←── SSE ──── 控制平面 ←── WS(S) ──── 用户本地机器
                     │                        │
                 PostgreSQL              本地文件系统
                 Redis                   本地浏览器
                                         LLM 直连
```

- 用户在本地安装轻量 Runtime
- 通过 WSS 反向连接云端控制平面
- 密码、Cookie、文件留在本地

### 4.3 纯本地模式

```
适用：离线环境、完全隐私、开发调试

前端 ←── SSE ──── 控制平面 ←── WS ──── 执行平面
  │                  │                     │
  └── localhost:3000 └── localhost:8080    └── localhost:8000
                         │
                     SQLite（替代 PostgreSQL）
                     无 Redis
```

- 所有组件跑在本地
- 控制平面退化为轻量版（SQLite 替代 PostgreSQL）
- 无长期记忆向量检索（或用本地 FAISS 替代）
- 无进化技能跨用户共享

## 5. 技术选型

### 5.1 控制平面

| 组件 | 技术 | 说明 |
|------|------|------|
| Web 框架 | Express (现有) | 保持不变 |
| 数据库 | PostgreSQL + pgvector (现有) | 保持不变 |
| 缓存 | Redis (现有) | 保持不变 |
| WebSocket | ws 库 | Node.js 原生 WebSocket 库 |
| SSE | 现有实现 | 增加缓冲区和断线重连 |
| 远程 MCP | 现有 MCP Service | 改为连接池模式 |

### 5.2 执行平面

| 组件 | 技术 | 说明 |
|------|------|------|
| 编排器 | LangGraph (现有) | 从 Runtime 迁移 |
| LLM 调用 | LangChain (现有) | 从 Runtime 迁移 |
| WebSocket 客户端 | websockets 库 | Python WebSocket 客户端 |
| 短期记忆 | MD 文件 | 替代 Redis |
| Checkpoint | JSON 文件 | LangGraph 状态持久化 |
| 本地 MCP | STDIO (现有) | 从 Runtime 迁移 |

### 5.3 虚拟机 / 容器

| 方案 | 启动时间 | 内存 | 适用场景 |
|------|---------|------|---------|
| Firecracker microVM | ~125ms | 512MB 起（含 Chrome 2GB） | 生产环境，高并发 |
| gVisor 容器 | ~100ms | 512MB 起（含 Chrome 2GB） | 生产环境，轻量 |
| Docker 容器 | ~1s | 512MB 起（含 Chrome 2GB） | 开发环境，简单部署 |
| 本地进程 | 即时 | 共享 | 开发调试 |

> 注：每用户一个虚拟机/容器，多 session 共享。不含 Chrome 时 512MB 足够，含 Chrome 时建议 2GB。

## 6. 与现有架构的对比

### 6.1 现有架构

```
Web → API → Runtime（单进程，所有 session 共享）
              │
         PostgreSQL + Redis
```

问题：
- Runtime 单进程，session 间文件冲突
- 所有逻辑耦合在一起
- 无法操作用户本地环境
- LLM 调用经过 API 中转

### 6.2 新架构

```
Web → 控制平面 → 执行平面（每用户一个虚拟机，多 session 共享）
         │              │
    PostgreSQL      用户文件系统（= 个人电脑）
    Redis           LLM 直连
```

改进：
- 每用户独立虚拟机，不同用户完全隔离
- 同一用户多 session 共享文件系统，如同在个人电脑上开多个终端
- 管理和执行职责分离
- 支持本地/云端/混合部署
- LLM 直连，延迟更低
- 资源利用率更高（每用户一个虚拟机，多 session 共享）

### 6.3 代码变更范围

```
保持不变：
├── apps/web/          前端基本不变（SSE 连接地址不变）
├── packages/          共享类型基本不变
└── database/          数据库 schema 小幅扩展

重构：
├── apps/api/          → 控制平面（移除 Runtime 调用，增加 WS 管理）
│   ├── adapters/runtime.adapter.ts  → 删除（不再 HTTP 调用 Runtime）
│   ├── services/chat.service.ts     → 改为通过 WS 转发
│   └── 新增 ws/ 目录                → WebSocket 连接管理
│
└── runtime/           → 执行平面（瘦身 + 增加 WS 客户端）
    ├── server/        → 删除 HTTP 服务器（改为 WS 客户端）
    ├── memory/        → short_term 改为 MD 文件
    ├── queue/         → 删除（不再用消息队列）
    └── 新增 ws/       → WebSocket 客户端 + 消息路由
```
