# 新架构设计

> 版本：2.0 | 日期：2026-02-26

## 1. 架构总览

### 1.1 当前架构（将被替代）

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  apps/web   │────▶│  apps/api    │────▶│    runtime        │
│  Next.js    │     │  Express     │ WS  │    Python         │
│  React      │     │  PostgreSQL  │     │    LangGraph      │
│             │     │  Redis       │     │    Docker Sandbox  │
└─────────────┘     └──────────────┘     └──────────────────┘
     前端              API 层(Node.js)       执行层(Python)
```

问题：
- 三个进程 + 两个数据库 + WebSocket 通信，启动门槛高
- Node.js API 层本质上只是 CRUD 代理，价值有限
- 多租户/认证代码占了 API 层 40%+ 的逻辑

### 1.2 新架构

```
┌──────────────────────────────────────────────────────────┐
│                    Semibot (单 Python 进程)                │
│                                                          │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐          │
│  │ CLI      │  │ Web UI    │  │ HTTP API     │          │
│  │ (主入口)  │  │ (可选)    │  │ (FastAPI)    │          │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘          │
│       └──────────────┼───────────────┘                   │
│                      │                                   │
│  ┌───────────────────┼──────────────────────────┐        │
│  │           事件源 / 消息入口                     │        │
│  │  (群聊 / 定时 / Webhook / 心跳 / 系统状态)     │        │
│  └───────────────────┬──────────────────────────┘        │
│                      ▼                                   │
│           ┌─────────────────────┐                        │
│           │    Event Engine     │                        │
│           │  (Reflex Engine)    │                        │
│           │  事件总线 + 规则引擎  │                        │
│           └──────────┬──────────┘                        │
│                      │                                   │
│          ┌───────────┼───────────┐                       │
│          ▼                       ▼                       │
│  ┌───────────────┐      ┌───────────────┐               │
│  │ 规则直接执行   │      │  Orchestrator │               │
│  │ (notify/log)  │      │  (LangGraph)  │               │
│  └───────────────┘      └───────┬───────┘               │
│                          ┌──────┼──────┐                 │
│                          ▼      ▼      ▼                 │
│                      ┌──────┐┌─────┐┌───────┐           │
│                      │Tools ││ MCP ││Skills │           │
│                      └──────┘└─────┘└───────┘           │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │  Memory  │  │   LLM    │  │ Sandbox  │               │
│  │          │  │  Router  │  │ (可选)   │               │
│  └──────────┘  └──────────┘  └──────────┘               │
│                      │                                   │
│               ┌──────┴──────┐                            │
│               │   SQLite    │                            │
│               │  (单文件)    │                            │
│               └─────────────┘                            │
└──────────────────────────────────────────────────────────┘
```

### 1.3 控制流说明

系统有两条控制流入口：

1. **用户主动请求**：CLI/API → Orchestrator → Tools/MCP/Skills
2. **事件驱动**：事件源 → Event Engine → 规则判定 → (规则直接执行 | Orchestrator 编排)

Event Engine 是事件的统一入口和治理层，Orchestrator 是复杂任务的编排层。两者的关系：
- Event Engine 决定"要不要做、怎么做"（规则匹配、风险判定、审批）
- Orchestrator 决定"具体怎么做"（PLAN → ACT → OBSERVE → REFLECT）
- 简单动作（notify、log_only）由 Event Engine 直接执行，不经过 Orchestrator

### 1.4 组件分层

| 层 | 组件 | 职责 |
|----|------|------|
| 入口层 | CLI、HTTP API、Web UI、群聊 | 接收用户请求和外部事件 |
| 事件层 | Event Engine（Reflex Engine） | 事件归一化、规则匹配、治理判定、审批 |
| 编排层 | Orchestrator（LangGraph） | 复杂任务的多步编排 |
| 能力层 | Tools、MCPs、Skills | 具体执行能力 |
| 基础层 | Memory、LLM Router、Sandbox | 记忆、模型、沙箱 |
| 存储层 | SQLite + sqlite-vec | 统一持久化 |

---

## 2. 组件设计

### 2.1 入口层

| 入口 | 说明 | 优先级 |
|------|------|--------|
| CLI | 命令行交互，主入口 | P0 必须 |
| HTTP API | FastAPI 轻量 HTTP 服务 | P1 重要 |
| 群聊（飞书） | 协作前台，详见 [feishu-gateway.md](./feishu-gateway.md) | P1 重要 |
| Web UI | 可选的浏览器管理界面（建议复用 Next.js） | P2 可选 |
| TUI | 终端交互界面（如 Textual） | 暂不优先（待需求验证） |

```bash
semibot chat                    # 交互式对话
semibot run "分析代码质量"        # 单次执行
semibot serve --port 8000       # HTTP API
semibot serve --port 8000 --ui  # 带 Web UI
semibot events list             # 事件管理
semibot rules list              # 规则管理
```

入口策略：
- 默认交互入口为 `CLI`
- `Web UI` 用于规则、审批、观测等管理场景
- `TUI` 暂不纳入近期里程碑
- Web UI 方案优先复用现有 `Next.js + React + Tailwind`，不在重构阶段切换新框架

### 2.2 Event Engine（事件引擎）

统一接收事件、匹配规则、治理执行、触发审批。

核心职责：
- 事件归一化与持久化
- 规则匹配与决策（ask/suggest/auto/skip）
- 治理（去重/冷却/注意力预算/风险分级）
- 路由到执行层（规则直接执行 或 Orchestrator 编排）

详见 [event-framework.md](./event-framework.md) 和 [event-processing.md](./event-processing.md)。

### 2.3 Orchestrator（编排器）

**完整保留**当前 LangGraph 状态机，这是核心差异化能力。

```
START → PLAN → ACT/DELEGATE → OBSERVE → REFLECT → RESPOND → END
              ↑______|              │
                     |______________|
```

变更点：
- 去掉 `org_id`、`user_id` 上下文传递
- 去掉 WebSocket RPC 调用 API 层的逻辑
- 直接调用本地 Python 模块
- 新增：Event Engine 可通过 `run_agent` / `execute_plan` 动作触发 Orchestrator

### 2.4 Tools（内置工具）

稳定、低成本、可直接调用的基础能力集，不依赖 LLM 解释。

**P0 必备工具：**
- `web_search` — 搜索
- `web_fetch` / `web_screenshot` — 浏览器访问
- `read_file` / `write_file` / `list_dir` — 文件访问
- `run_code` — 代码执行
- `run_shell` — 命令执行

**P1 增强工具：**
- `pdf_read` / `sheet_edit` — PDF/表格处理
- `image_annotate` — 图片处理
- `time_now` / `schedule_once` — 时间与日程

**设计原则：**
- Tool 能力可直接调用，不依赖 SKILL.md
- 规则引擎可直接触发 Tool，减少 LLM 参与
- 执行必须可审计

### 2.4.1 Tools / MCPs / Skills 协同

| 能力层 | 特点 | 适用场景 |
|--------|------|---------|
| Tools | 稳定、低成本、可直接调用 | 搜索、文件访问、代码执行 |
| MCPs | 外部能力扩展（服务端工具） | 接入第三方系统 |
| Skills | 复杂任务流程与策略 | 需要 LLM 推理的场景 |

调度优先级：规则引擎优先触发 Tools，其次 MCPs，最后 Skills。

### 2.4.2 能力图（Capability Graph）

复用现有 `CapabilityGraph` 机制，将 Tools/MCPs/Skills 统一注册为可调用能力：

- 统一校验可调用性  
- 统一审计与风险标注  
- 为规则引擎提供“可触发能力列表”  

### 2.5 Skills（技能系统）

简化双层模型为**单层 + 本地文件系统**：

```
当前：SkillDefinition(DB) + SkillPackage(DB+文件) + agent_skills(DB)
新：  ~/.semibot/skills/{skill-name}/SKILL.md
```

保留：SKILL.md 格式（与 OpenClaw 兼容）、懒加载、进化技能、MCP 工具集成。
去掉：安装状态机、安装审计日志、版本锁定、多租户隔离。
新增：`semibot skill install <url>` 一键安装、本地目录自动发现。

### 2.6 Memory（记忆系统）

详见 [memory-system.md](./memory-system.md)。

- 短期记忆：Redis → 进程内存 dict
- 长期记忆：PostgreSQL + pgvector → SQLite + sqlite-vec
- 新增：MemoryConsolidator（沉淀器）
- 新增：与 Event Engine 集成（`memory.write.important` 事件）

### 2.7 MCP Client

**完整保留**，支持 STDIO / HTTP-SSE / Streamable HTTP 三种传输。

配置改为本地文件 `~/.semibot/mcp.json`：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "url": "https://mcp.github.com",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

### 2.8 LLM Router

**完整保留**多模型支持：OpenAI / Anthropic / Google / Ollama。

```toml
# ~/.semibot/config.toml
[llm]
default = "anthropic/claude-sonnet-4-20250514"
fallback = "openai/gpt-4o"

[llm.providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[llm.providers.openai]
api_key_env = "OPENAI_API_KEY"

[llm.providers.ollama]
base_url = "http://localhost:11434"
```

### 2.9 Sandbox（沙箱）

**改为可选**，默认本地执行。

```bash
semibot chat              # 默认：本地执行（信任模式）
semibot chat --sandbox    # 可选：Docker 沙箱隔离
```

保留 Docker 沙箱的全部能力（容器池、资源限制、网络隔离），但不再是必须依赖。

### 2.10 存储层

**SQLite 单文件**替代 PostgreSQL + Redis。

```
~/.semibot/
├── semibot.db          # SQLite 主数据库
├── config.toml         # 全局配置
├── mcp.json            # MCP Server 配置
├── rules/              # 事件规则
│   └── default.json
└── skills/             # 技能目录
    ├── web-search/
    │   └── SKILL.md
    └── code-executor/
        └── SKILL.md
```

SQLite 表结构包含：
- `sessions` — 会话
- `messages` — 消息历史
- `memories` + `memory_vectors` — 长期记忆 + 向量索引
- `evolved_skills` + `evolved_skill_vectors` — 进化技能 + 向量索引
- `execution_logs` — 执行日志
- `events` — 事件日志
- `event_rules` — 事件规则
- `event_rule_runs` — 规则执行记录
- `approval_requests` — 审批请求

完整表结构详见 [event-processing.md](./event-processing.md) 第 4 节。

---

## 3. 删除的组件

| 组件 | 原因 |
|------|------|
| apps/api (Express) | Python FastAPI 替代 |
| apps/web (Next.js) | 可选保留，不再必须 |
| 认证系统 (JWT/API Key) | 单用户不需要 |
| 多租户隔离 (org_id) | 不再支持 |
| WebSocket 通信 | 单进程内直接调用 |
| Redis | 内存 dict + SQLite 替代 |
| PostgreSQL + pgvector | SQLite + sqlite-vec 替代 |
| 用户/组织/权限表 | 删除 |
| 限流中间件 | 单用户不需要 |

---

## 4. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | Python 3.11+ | 统一为单语言，LangGraph 生态 |
| 编排 | LangGraph | 核心差异化 |
| HTTP | FastAPI | 轻量、异步、自动文档 |
| CLI | Typer + Rich | 现代 Python CLI |
| 存储 | SQLite | 零配置、单文件 |
| 向量 | sqlite-vec | 与 SQLite 一体 |
| 嵌入缓存 | 进程内 LRU | 替代 Redis |
| 配置 | TOML | Python 标准库原生支持 |

---

## 5. 启动流程

```python
def main():
    # 1. 加载配置
    config = load_config("~/.semibot/config.toml")

    # 2. 初始化 SQLite
    db = init_database("~/.semibot/semibot.db")

    # 3. 初始化组件
    llm = LLMRouter(config.llm)
    memory = MemoryManager(db, llm)
    skills = SkillRegistry("~/.semibot/skills/")
    mcp = McpManager("~/.semibot/mcp.json")
    sandbox = SandboxManager() if config.sandbox_enabled else LocalExecutor()
    events = EventEngine(db, rules_path="~/.semibot/rules/")

    # 4. 构建 Orchestrator
    orchestrator = build_orchestrator(
        llm=llm, memory=memory, skills=skills,
        mcp=mcp, executor=sandbox, event_engine=events,
    )

    # 5. 启动入口
    if config.mode == "cli":
        run_cli(orchestrator)
    elif config.mode == "serve":
        run_server(orchestrator, port=config.port)
```

---

## 6. 包分发

目标：`pip install semibot` 一行安装。

```toml
[project]
name = "semibot"
version = "0.1.0"
description = "Agent orchestration engine with planning, reflection, and self-evolution"
requires-python = ">=3.11"

dependencies = [
    "langgraph>=0.2",
    "langchain-core>=0.3",
    "fastapi>=0.115",
    "uvicorn>=0.32",
    "typer>=0.12",
    "sqlite-vec>=0.1",
    "httpx>=0.27",
]

[project.optional-dependencies]
sandbox = ["docker>=7.0"]
ui = ["nicegui>=2.0"]

[project.scripts]
semibot = "semibot.main:main"
```
