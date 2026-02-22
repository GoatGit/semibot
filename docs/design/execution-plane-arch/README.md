# Semibot 执行平面架构重构设计

> 将 Semibot 从单体架构重构为 **Web → 控制平面 → 执行平面** 三层架构，实现用户级虚拟机隔离、多 session 进程复用、多部署模式支持和离线能力。

## 文档索引

| 文档 | 内容 | 状态 |
|------|------|------|
| [01-产品设计](./01-PRODUCT-VISION.md) | 产品理念、定位、用户场景、与 OpenClaw 差异化 | ✅ |
| [02-架构总览](./02-ARCHITECTURE-OVERVIEW.md) | 三层架构、部署模式、数据流、技术选型 | ✅ |
| [03-控制平面设计](./03-CONTROL-PLANE.md) | 控制平面职责、模块拆分、API 设计、数据模型变更 | ✅ |
| [04-执行平面设计](./04-EXECUTION-PLANE.md) | 执行平面职责、RuntimeAdapter 抽象层、SemiGraph/OpenClaw 双运行时、OpenClaw Bridge、短期记忆、用户级虚拟机、多 session 进程管理 | ✅ |
| [05-WebSocket 协议](./05-WEBSOCKET-PROTOCOL.md) | 统一 WebSocket 通信协议、消息类型、断线重连、SSE 中转 | ✅ |
| [06-迁移计划](./06-MIGRATION-PLAN.md) | 从现有架构分阶段迁移的具体步骤和风险控制 | ✅ |
| [08-生产环境版本一致性关键需求](./08-PRODUCTION-VERSION-CONSISTENCY-REQUIREMENTS.md) | 生产与分布式场景下的版本发布、滚动升级、一致性校验、回滚与可观测关键需求 | 🆕 |

## 核心设计决策

1. **每用户一个虚拟机** — 同一用户的多个 session 共享一个虚拟机，虚拟机就是用户的"个人电脑"，session 之间通过独立进程运行，文件系统自然共享
2. **统一 WebSocket 通信** — 每个虚拟机一条 WebSocket 连接控制平面，多 session 消息通过 session_id 多路复用
3. **Runtime 一分为二** — 编排（LangGraph）和执行（文件/代码/浏览器）放执行平面，管理（技能/记忆/进化/审计）放控制平面
4. **LLM 直连** — 执行平面直连 LLM Provider，不经过控制平面中转
5. **技能分层** — 控制平面是"技能仓库"（定义、版本、市场），执行平面是"技能运行时"（懒加载、执行）
6. **MCP 分治** — 平台远程 MCP 放控制平面共享连接池，本地 STDIO MCP 放执行平面
7. **双运行时支持** — 执行平面同时支持 SemiGraph（Python/LangGraph）和 OpenClaw（Node.js）两种 runtime，每个 session 二选一，通过 RuntimeAdapter 抽象层统一管理，控制平面和前端无需感知差异

## 架构一句话

```
控制平面管"是什么"（Agent 定义、技能目录、长期记忆、审计计费）
执行平面管"怎么做"（LangGraph 编排、代码执行、文件操作、LLM 调用）
每用户一个虚拟机，虚拟机 = 个人电脑
一条 WebSocket 连接一切，多 session 多路复用
```

## 相关文档

- [现有架构设计](../ARCHITECTURE.md)
- [数据模型设计](../DATA_MODEL.md)
- [OpenClaw 对比分析](../../research/openclaw-comparison-analysis.md)
