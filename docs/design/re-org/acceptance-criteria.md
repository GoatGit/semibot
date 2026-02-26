# 重构验收标准（DoD）

> 目标：给每个阶段定义可验证的完成标准，避免“完成但不可用”。

## 全局标准

- 单机可运行：`semibot chat` 可直接启动
- 文档与实现一致：核心模块与接口命名一致
- 审计可追踪：事件、规则执行、审批结果可查询
- 回归通过：关键路径测试通过

## Phase 1（存储替换）验收

- SQLite 成为唯一必选持久化组件
- PostgreSQL/Redis 连接路径移除
- 记忆检索与写入可用
- 历史会话迁移脚本可执行

## Phase 2（架构收缩）验收

- Node API 层可下线
- Python 单进程提供 CLI + HTTP API
- 无 WebSocket RPC 依赖
- 编排链路不回退

## Phase 3（去认证+打包）验收

- 无 `org_id`/`user_id` 强耦合
- 无 JWT/API Key 认证依赖
- `pip install semibot && semibot chat` 可工作
- 首次启动自动初始化目录和数据库

## Phase 4（事件引擎 MVP）验收

- 事件写入 `events` 表
- 规则匹配可触发 `notify/run_agent`
- 去重/冷却/风险分级生效
- 高风险动作必须 HITL
- `semibot events/rules/approvals` 命令可用

## Phase 5（群聊协作+进化）验收

- 飞书消息可转事件
- 审批卡片回传生效
- Supervisor-Worker 协作链路可见
- 进化候选可自动生成并进入审核流

