# Semibot 重构：从 SaaS 平台到通用 Agent 引擎

> 版本：2.0 | 日期：2026-02-26 | 状态：草稿

## 背景

Semibot 当前定位为"企业级 SaaS AI Agent 平台"，依赖 PostgreSQL + Redis + Docker + Express API + WebSocket 的重型技术栈。本次重构将其转型为面向开发者的通用 Agent 编排引擎。

## 一句话定位

能干活、能提醒、能协作、能自己变强的数字员工。

## 四大核心特性

1. **快速执行** — 预热容器池、MCP 连接池、能力图快速路由
2. **主动工作** — 事件驱动（hooks/webhooks/heartbeat/cron → event）+ 规则治理
3. **互相协作** — Supervisor-Worker 多 Agent 分工、群聊协作前台
4. **持续进化** — evolved_skills 自动提取 → 评分 → 审核 → 复用

详见 [core-pillars.md](./core-pillars.md)。

## 重构范围

- **保留**：LangGraph 编排、进化技能、记忆系统、MCP 集成、沙箱执行
- **新增**：事件引擎（Reflex Engine）、Tools 能力层、群聊协作、HITL 审批
- **删除**：多租户隔离、用户系统、Node.js API 层、PostgreSQL、Redis

## 与 OpenClaw 的差异化

| 能力 | Semibot | OpenClaw |
|------|---------|----------|
| 任务编排 | LangGraph 完整状态机 | 简单循环 |
| 主动工作 | 统一事件框架 + 规则治理 | 分散触发点 |
| Agent 自进化 | evolved_skills 闭环 | 无 |
| 记忆深度 | 短期 + 长期 + 自动沉淀 | Markdown 文件 |
| MCP 集成 | 三种传输 + 连接池 | 仅 STDIO |
| 可观测性 | 完整执行审计 | 基础日志 |

## 设计原则

1. **单文件优于分布式** — SQLite 替代 PostgreSQL + Redis
2. **进程内优于跨进程** — 内存 dict 替代 Redis，函数调用替代 WebSocket
3. **可选优于必选** — Docker 沙箱、Web UI 均为可选
4. **规则先行、Agent 兜底** — 事件先走规则引擎，需要推理时才用 LLM
5. **渐进增强** — 核心功能零依赖，高级功能按需引入

## 常见问题（澄清）

**Q：事件是否需要自己定义和处理，需要后续开发者进行二次开发吗？**  
A：不一定。基础事件由平台内置并统一成标准事件模型，开发者主要通过规则配置触发执行。只有业务专属事件才需要 Webhook/SDK 注入或自定义处理。

**Q：事件处理本身是 Agent 还是规则/代码？**  
A：规则先行、Agent 兜底。事件先经过规则引擎（条件、去重、风险分级），简单动作直接执行，复杂任务才交给 Agent。

**Q：注意力预算是什么？**  
A：给系统设“主动打扰额度”，例如每天最多提醒 5 次，超过则不再提醒，避免刷屏与打扰。

**Q：CLI 是什么？**  
A：`CLI` 是命令行入口（Command Line Interface），通过终端命令直接使用 Semibot，例如 `semibot chat`、`semibot run`、`semibot events list`。

**Q：重构后保留哪种交互入口？**  
A：默认采用 `CLI` 主入口；`Web UI` 作为可选管理面板；`TUI` 暂不优先，后续根据实际需求决定是否纳入路线图。

**Q：这些高级能力需要可视化，Web UI 能胜任吗？需要 TUI 吗？OpenClaw 是怎么做的？**  
A：Web UI 能胜任并且应作为首选可视化方案；TUI 不作为当前优先项。原因是事件流、审批、规则仿真、回放和协作看板都更适合 Web 交互。TUI 更适合纯终端运维场景，可在后续按真实需求补充。根据现有对 OpenClaw 的研究，OpenClaw 主要依赖多渠道聊天入口（Telegram/Discord/Slack/WhatsApp/Web）与配置驱动能力实现协作和自动化，而不是以内建可观测控制台为核心差异点。

**Q：OpenClaw 的 dashboard 是自研，还是用其他开源 UI 框架？**  
A：官方文档显示它是自研的 Control UI（由 Gateway 提供静态页面），技术栈是 `Vite + Lit`。也就是说不是直接套用现成 dashboard 产品，但底层用了开源前端框架与构建工具。

**Q：Semibot WebUI 该复用原有框架，还是换新的开源方案？**  
A：当前阶段建议复用原有 `Next.js + React + Tailwind`。这是最低迁移成本、最快交付和最稳妥方案。WebUI 仅承担可视化管理（规则、审批、回放、观测），核心运行时仍以 `CLI + Python` 为主。暂不建议为此切换到新框架（如 Vite+Lit/TUI），避免重构期并行引入第二类风险。

**Q：会话里报错“执行平面未就绪（状态: provisioning）”是什么意思？**  
A：表示控制平面已下发启动，但执行平面进程尚未成功连回 `/ws/vm`。重构后已修复一个关键兼容问题：`python -m src.main` 在带 `VM_USER_ID/VM_TOKEN` 环境变量且无子命令时，会自动进入执行平面模式（而不是报 CLI 参数错误）。若仍出现该报错，先检查 `/tmp/semibot-runtime-<user_id>.log`、`GET /api/v1/vm/status`，必要时调用 `POST /api/v1/vm/rebootstrap`。

**Q：Semibot 的 Tools 可以新增/删除吗？**  
A：不可以。V2 中 Tools 统一按“内建能力”管理，前端与 API 都不提供新增/删除。可配置项包括：启停、权限、限流、超时，以及“需要外部服务”的工具的 endpoint/key。`code_executor` 不需要 endpoint/key。建议最小内建集至少覆盖 `search`、`code_executor`、`file_io`（读写/列目录）。`xlsx` / `pdf` 归类为 Skills，不计入 Tools。

**Q：前端里 Tools 要区分“Runtime 内置工具”和“其他工具”吗？**  
A：不区分。配置中心只展示一个统一工具列表，用户只关心“这个工具能不能用、怎么配”，而不是工具来源。

**Q：file_io 的权限能否细粒度控制？**  
A：可以。支持按 `file.read` / `file.write` / `file.list` 分别开关；在配置页里用复选框直接配置，保存后写入对应工具配置。

**Q：Tools / MCP 配置存储在哪里？**  
A：统一存储在本地 `~/.semibot/semibot.db`（runtime SQLite）。API 不再依赖 Postgres 的 `tools` / `mcp_servers` 持久化。`~/.semibot/config.toml` 仅保留基础运行参数（路径、默认模型等）。

**Q：旧版 Postgres 的 Tools / MCP 数据怎么迁移？**  
A：可用脚本 `runtime/scripts/migrate_pg_config_to_sqlite.py` 一次性迁移。
```bash
cd runtime
.venv/bin/python scripts/migrate_pg_config_to_sqlite.py \
  --database-url 'postgresql://localhost:5432/semibot' \
  --clear-existing
```
仅查看源数据数量（不落库）：
```bash
cd runtime
.venv/bin/python scripts/migrate_pg_config_to_sqlite.py \
  --database-url 'postgresql://localhost:5432/semibot' \
  --dry-run
```

## 文档索引

### 架构与核心

| 文档 | 内容 |
|------|------|
| [架构设计](./architecture.md) | 新架构总览、组件设计、技术选型 |
| [前端重构设计](./frontend-design.md) | Web UI 信息架构、页面设计、状态流与落地里程碑 |
| [核心特性](./core-pillars.md) | 四大特性的机制落点与可验证指标 |
| [CLI 设计](./cli-design.md) | Semibot V2 命令体系、输出规范与实施里程碑 |
| [记忆系统](./memory-system.md) | 短期记忆 + 长期记忆 + 沉淀器 |
| [术语表](./glossary.md) | 关键概念与判定术语 |

### 事件引擎（Reflex Engine）

| 文档 | 内容 |
|------|------|
| [事件框架总览](./event-framework.md) | 统一事件驱动与治理机制 |
| [事件处理详细设计](./event-processing.md) | 事件模型、规则引擎、动作路由、审批、可观测性（完整参考） |
| [事件引擎接口](./event-engine-interfaces.md) | 模块边界、数据结构、接口签名 |
| [实现级规范](./implementation-spec.md) | 模块划分、伪代码、MVP 清单 |
| [关键时序](./event-sequences.md) | 事件、审批、群聊、进化的核心流程 |
| [模块级设计](./module-design.md) | 类职责、依赖方向、接入点 |
| [API 契约](./api-contracts.md) | 事件/规则/审批接口 schema |
| [测试用例模板](./test-cases.md) | 单元、集成、E2E 测试基线 |
| [CI 门禁](./ci-gates.md) | Core + E2E 分组与分支保护建议 |
| [分支保护手册](./branch-protection.md) | GitHub Required Checks 实操配置 |
| [边界清单](./engine-orchestrator-boundary.md) | Event Engine 与 Orchestrator 边界与集成步骤 |

### 集成与扩展

| 文档 | 内容 |
|------|------|
| [飞书群聊接入](./feishu-gateway.md) | 群聊协作前台、卡片模板 |
| [进化流水线](./evolution-pipeline.md) | 事件驱动技能进化 |

### 迁移

| 文档 | 内容 |
|------|------|
| [迁移计划](./migration-plan.md) | 5 阶段迁移方案 |
| [重构 Backlog](./refactor-backlog.md) | 按优先级的实施任务清单 |
| [验收标准](./acceptance-criteria.md) | 各阶段 DoD 与完成定义 |
| [关键决策](./decisions.md) | 已确认决策与待定项 |
| [设计完成度矩阵](./design-status.md) | 设计边界与实现门槛 |

## 路线图

**阶段 1：基础重构**
- 存储替换（SQLite）+ 架构收缩（Python 单进程）+ 去认证 + 打包分发（CLI 主入口）

**阶段 2：事件驱动 MVP**
- 统一事件模型 + 规则引擎（去重/冷却/风险分级）+ HITL 审批 + Web UI 管理面板（可选）

**阶段 3：群聊协作 + 进化闭环**
- 飞书接入 + Supervisor-Worker 群内可视化 + 进化技能自动提取与发布
