# 设计完成度矩阵

> 目标：明确设计阶段的完成边界，区分“已完成设计”与“待实现”。

## 完成度总览

| 领域 | 状态 | 说明 |
|------|------|------|
| 架构总览 | 已完成 | 单进程架构、组件分层、控制流 |
| 事件模型 | 已完成 | 事件 envelope、类型分层、表结构 |
| 规则引擎 | 已完成 | 条件表达、治理策略、动作路由 |
| 审批机制 | 已完成 | HITL 状态机、双层审批、接口 |
| 群聊接入 | 已完成 | 飞书前台、卡片流、回传链路 |
| 技能进化 | 已完成 | 事件化流水线与触发条件 |
| API 契约 | 已完成 | 事件/规则/审批请求响应结构 |
| 测试基线 | 已完成 | 单元/集成/E2E 用例模板 |
| CI 门禁 | 已完成 | Core + E2E 分组已接入 workflow |
| 迁移计划 | 已完成 | 5 阶段路径与验收标准 |
| 实现任务拆解 | 已完成 | Backlog 与优先级 |

## 待实现阶段产物（不属于设计缺失）

- 真实代码模块落地（`semibot/events/*`）
- CLI 交互聊天环（`semibot chat` REPL）与 TUI/WebUI 增强
- 自动化测试脚本与 CI 接入
- 飞书网关实装与联调

## 近期实现进展（2026-02-26）

- 已落地 `semibot run`：单次任务直接走 Orchestrator + Event Engine
- 已落地 `semibot serve`：CLI 直接启动 FastAPI 事件服务
- 已落地 `semibot chat` 交互/单轮模式（`--message`）
- 已落地 `semibot init`：首次启动自动初始化本地目录、配置、数据库、默认规则
- 已落地 `python -m semibot` 模块入口
- 已落地 `POST /v1/chat`、`GET /v1/skills`、`GET /health`
- 已补齐 Phase 2 API 最小面：`/v1/sessions`、`/v1/agents`、`/v1/memories/search`
- 已完成本地执行链路去强耦合：`RuntimeSessionContext/create_initial_state` 对 `org_id/user_id` 提供兼容默认值（`local`）
- 已新增 CLI 单测：`runtime/tests/test_cli.py`

## 进入实现阶段门槛

- `acceptance-criteria.md` 已作为阶段 DoD
- `refactor-backlog.md` 可直接排期
- `module-design.md` 和 `api-contracts.md` 可直接指导编码
