# 重构实施 Backlog（优先级）

> 目标：把设计转成可执行任务队列，按依赖顺序推进。

## P0（必须先做）

- 建立 `semibot/storage` SQLite 统一访问层
- 落地 `semibot/events/event_store.py` 与 `events` 表
- 落地 `rules_engine.py`（匹配 + 去重 + 冷却 + 风险）
- 落地 `event_router.py`（先支持 `notify/run_agent`）
- 在 `BaseAgent.run` 和 `UnifiedActionExecutor.execute` 接入事件发射

## P1（MVP 完整）

- 落地 `approval_manager.py` 与 HITL CLI 流
- 增加 `events/rules/approvals` API 与 CLI
- 增加规则文件加载与热更新
- 增加 `replay_manager.py`
- 增加核心测试：幂等、审批、回放、决策路径
- Web UI：完成无鉴权模式收口（不再跳转登录页）
- Web UI：配置中心与 runtime 配置统一（LLM/Tools/Skills）

## P2（协作增强）

- 飞书 Gateway 接入
- 群聊卡片模板与审批回传
- Supervisor-Worker 群聊协作视图
- Web UI：新增 `events/rules/approvals` 三页与回放链路
- Web UI：Dashboard 增加实时态势与待审批队列

## P3（进化增强）

- 进化候选提取自动化
- 评分与审核队列
- 技能发布与复用统计

## 风险与防线

- 风险：规则误触发造成噪声  
防线：默认冷却 + 注意力预算 + 可观测告警

- 风险：高风险动作漏审  
防线：风险等级默认策略 + 工具层 `approval_hook` 双保险

- 风险：文档实现偏移  
防线：每阶段完成后对照 `acceptance-criteria.md` 打勾验收
