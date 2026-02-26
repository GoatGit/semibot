# 迁移计划：从 SaaS 平台到单进程 Agent 引擎

> 版本：2.0 | 日期：2026-02-26

## 迁移策略

采用**渐进式迁移**，分 5 个阶段。每个阶段结束后系统可独立运行。

执行基准：
- 任务拆解参考 [refactor-backlog.md](./refactor-backlog.md)
- 阶段验收参考 [acceptance-criteria.md](./acceptance-criteria.md)

```
Phase 1: 存储层替换（PostgreSQL/Redis → SQLite/内存）
    ↓
Phase 2: 架构收缩（砍 Node.js API 层，Python 单进程）
    ↓
Phase 3: 去认证 + 打包分发
    ↓
Phase 4: Event Engine MVP（事件模型 + 规则引擎）
    ↓
Phase 5: 群聊协作 + 进化闭环
```

---

## Phase 1：存储层替换

> 目标：去掉 PostgreSQL 和 Redis 依赖

| 原存储 | 原用途 | 迁移目标 |
|--------|--------|---------|
| PostgreSQL | sessions/messages/agents/skills/logs | SQLite |
| PostgreSQL + pgvector | memories + 向量索引 | SQLite + sqlite-vec |
| PostgreSQL | users/organizations/api_keys | **删除** |
| Redis | 短期记忆 | 进程内存 dict |
| Redis | Embedding 缓存 | 进程内 LRU cache |
| Redis | 分布式限流/锁/队列 | **删除** |

新建 `semibot/memory/` 模块（详见 [memory-system.md](./memory-system.md)）：
- `short_term.py` — 纯内存 dict
- `long_term.py` — SQLite + sqlite-vec
- `consolidator.py` — 沉淀器
- `manager.py` — 统一入口

**验证标准：**
- [ ] `semibot.db` 单文件包含所有持久化数据
- [ ] 无 PostgreSQL / Redis 连接代码残留
- [ ] 向量检索功能正常
- [ ] 沉淀器能在会话结束时正确提取记忆

---

## Phase 2：架构收缩

> 目标：从三进程收缩为单 Python 进程

入口策略：
- `CLI` 为主入口
- `Web UI` 仅作为可选能力
- `TUI` 不纳入当前迁移阶段

### 砍掉 Node.js API 层

| 原职责 | 迁移方案 |
|--------|---------|
| REST API 路由 | FastAPI 内嵌 |
| Zod 输入验证 | Pydantic model |
| Repository 层 | 直接操作 SQLite |
| Service 层 | 合并到 Python 引擎 |
| WebSocket 服务端 | **删除** |

### 新增 CLI 入口

```bash
semibot chat                    # 交互式对话
semibot run "完成这个任务"        # 单次执行
semibot serve --port 8000       # HTTP API
semibot skill list              # 技能管理
semibot memory search <query>   # 记忆管理
```

### 新增内嵌 API（FastAPI）

```
POST   /v1/chat                 # 对话（SSE 流式）
GET    /v1/sessions             # 会话列表
DELETE /v1/sessions/:id         # 删除会话
GET    /v1/skills               # 技能列表
POST   /v1/skills/install       # 安装技能
GET    /v1/memories/search      # 记忆搜索
GET    /v1/agents               # Agent 列表
GET    /health                  # 健康检查
```

**验证标准：**
- [ ] `apps/api/` 目录可完全删除
- [ ] `packages/` 目录可完全删除
- [ ] 单 `python -m semibot` 启动全部功能
- [ ] CLI 交互式对话正常
- [ ] FastAPI 端点功能正常
- [ ] LangGraph 状态机编排正常

---

## Phase 3：去认证 + 打包分发

> 目标：清理多租户/认证代码，实现 `pip install semibot`

### 删除的概念

| 概念 | 涉及范围 |
|------|---------|
| `org_id` | 所有查询条件、表字段、上下文传递 |
| `user_id` | 同上 |
| `created_by` / `updated_by` | 审计字段简化 |
| JWT / API Key | 中间件、token 生成/验证 |
| 角色权限（RBAC） | 权限检查逻辑 |

### 打包分发

```toml
[project]
name = "semibot"
dependencies = [
    "langgraph>=0.2", "langchain-core>=0.3",
    "click>=8.0", "httpx>=0.27",
    "pydantic>=2.0", "sqlite-vec>=0.1",
]

[project.optional-dependencies]
api = ["fastapi>=0.115", "uvicorn>=0.32"]
sandbox = ["docker>=7.0"]
openai = ["openai>=1.50"]
anthropic = ["anthropic>=0.39"]

[project.scripts]
semibot = "semibot.cli:cli"
```

### 首次启动流程

```bash
$ pip install semibot
$ semibot chat
# 自动创建 ~/.semibot/、semibot.db、config.toml
# 检测环境变量中的 API Key
# 进入交互式对话
```

**验证标准：**
- [ ] 代码中无 `org_id` / `user_id` 残留
- [ ] 无 JWT/API Key 相关代码
- [ ] `pip install semibot && semibot chat` 一行启动
- [ ] 首次运行自动初始化

---

## Phase 4：Event Engine MVP

> 目标：实现统一事件驱动与规则治理

### 新建模块

```
semibot/events/
├── event_bus.py           # 进程内事件队列与分发
├── event_store.py         # SQLite 持久化
├── rules_engine.py        # 规则匹配与治理判断
├── rule_evaluator.py      # 条件表达式解析
├── event_router.py        # 动作路由
├── approval_manager.py    # HITL 审批
└── attention_budget.py    # 注意力预算与冷却
```

### 接入点

- `BaseAgent.run()` 触发 `agent.lifecycle.*`
- `UnifiedActionExecutor.execute()` 触发 `tool.exec.*`
- Cron/Heartbeat/Webhook 统一转为事件

### MVP 范围

1. 事件模型 + 事件日志（events 表）
2. 规则引擎（匹配 + 去重 + 冷却 + 风险分级）
3. 动作路由（notify + run_agent）
4. HITL 审批（pending → approved/rejected）
5. 三类事件接入：agent.lifecycle / tool.exec / scheduler.cron

详见 [event-processing.md](./event-processing.md)。
实现参考：
- [module-design.md](./module-design.md)
- [api-contracts.md](./api-contracts.md)
- [test-cases.md](./test-cases.md)
- [engine-orchestrator-boundary.md](./engine-orchestrator-boundary.md)

### 新增 API/CLI

```bash
semibot events list
semibot events replay <event_id>
semibot rules list
semibot rules enable/disable <rule_id>
semibot approvals list
```

**验证标准：**
- [ ] 事件写入 events 表并可查询
- [ ] 规则匹配和治理判断正常（去重/冷却/风险）
- [ ] notify 动作能发送通知
- [ ] run_agent 动作能触发 Orchestrator
- [ ] 高风险动作走 HITL 审批

---

## Phase 5：群聊协作 + 进化闭环

> 目标：飞书群聊接入 + 技能进化事件化

### 群聊协作

- 飞书群消息 → `chat.message.*` 事件
- 审批卡片 → `approval.*` 事件
- Supervisor-Worker 协作流在群内可视化

详见 [feishu-gateway.md](./feishu-gateway.md)。

### 进化闭环

将技能进化纳入事件框架：

```
task.completed → evolution.candidate.created → scored → review → approved
```

详见 [evolution-pipeline.md](./evolution-pipeline.md)。

### 记忆系统事件集成

- 沉淀器由 `session.ended` 事件触发
- 重要记忆写入时发出 `memory.write.important` 事件
- 规则可基于记忆事件触发后续动作

**验证标准：**
- [ ] 飞书群消息能触发事件
- [ ] 审批卡片能回传结果
- [ ] 进化候选能自动生成和评分
- [ ] 记忆沉淀由事件触发

---

## 迁移后删除的目录

```
apps/api/                        # Express.js API 层
apps/web/                        # Next.js 前端（可独立仓库保留）
packages/shared-types/           # TypeScript 类型
packages/shared-config/          # TypeScript 配置
packages/ui/                     # UI 组件库
database/migrations/             # PostgreSQL 迁移文件
infra/docker-compose.yml         # 多服务编排
infra/scripts/install-vm.sh      # VM 安装脚本
```

保留并迁移的目录：

```
runtime/src/orchestrator/  → semibot/orchestrator/
runtime/src/skills/        → semibot/skills/
runtime/src/mcp/           → semibot/mcp/
runtime/src/sandbox/       → semibot/sandbox/
runtime/src/llm/           → semibot/llm/
runtime/src/memory/        → semibot/memory/（重构）
```

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| sqlite-vec 生态不成熟 | 备选 ChromaDB，接口层抽象隔离 |
| LangGraph 依赖链过重 | 评估轻量替代或延迟加载 |
| 现有测试全部失效 | 每个 Phase 结束后补充对应测试 |
| Event Engine 复杂度 | 独立为 Phase 4，MVP 只做核心功能 |
