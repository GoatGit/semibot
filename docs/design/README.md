# Semibot - 通用 Agent 平台

## 概述

Semibot 是一个极简的云原生 Agent 编排平台，让开发者能够快速构建、部署和管理 AI 智能体。

## 设计原则

1. **极简架构** - 最少的组件，最大的灵活性
2. **云原生** - Serverless 优先，按需扩缩容
3. **前后端分离** - 独立部署，独立演进
4. **多语言协作** - Node.js API 层 + Python Runtime
5. **可组合** - Agent、Skill、Tool 自由组合

## 核心特性

| 特性 | 说明 |
| ---- | ---- |
| **多租户** | 组织级隔离，独立配额与权限控制 |
| **多模型** | OpenAI、Anthropic、Google、本地模型统一适配 |
| **多语言** | 国际化支持，API 响应与错误消息多语言 |
| **MCP 兼容** | 完整支持 Model Context Protocol，兼容 Claude MCP |
| **多 SubAgent** | 父子 Agent 编排，任务分发与结果汇总 |
| **多 Skills/Tools** | 可组合的能力单元，支持自定义扩展 |
| **自我进化** | Agent 自动从成功任务中提炼技能，持续积累能力 |

## 核心概念

| 概念 | 定义 |
| ---- | ---- |
| **Agent** | 具有角色、目标、记忆的智能体实例 |
| **SubAgent** | 被父 Agent 编排调用的子智能体 |
| **Skill** | Agent 可调用的能力单元（封装一组 Tools） |
| **Tool** | 最小执行单元（API调用、代码执行、数据查询） |
| **MCP Server** | Model Context Protocol 服务器，提供标准化工具接口 |
| **Memory** | 短期(对话) + 长期(向量) 记忆系统 |
| **Session** | 一次完整的用户交互会话 |
| **Evolution** | Agent 自我进化机制，从实践中自动提炼可复用技能 |

## 文档目录

### design/ — 系统设计

- [架构设计](./ARCHITECTURE.md) - 系统整体架构
- [数据模型](./DATA_MODEL.md) - 数据库设计
- [API 设计](./API_DESIGN.md) - 接口规范
- [Agent Runtime](./AGENT_RUNTIME.md) - Python 执行引擎
- [进化系统](./EVOLUTION.md) - Agent 自我进化与技能自生成
- [Design System](./DESIGN_SYSTEM.md) - 前端设计系统规范
- [错误码规范](./ERROR_CODES.md) - 错误码定义
- [测试框架](./TESTING.md) - 测试策略与规范
- [部署指南](./DEPLOYMENT.md) - 部署配置
- [产品需求](./PRODUCT_REQUIREMENTS.md) - 产品需求文档
- [原始需求](./原始需求.md) - 初始需求文档
- [重构方案](./REFACTORING_PLAN.md) - 6 项重构设计方案
- [Cron 调度设计](./CRON_SCHEDULING_DESIGN.md) - 定时任务（控制层调度 + 执行层执行）
- [Gateway 入口与 Telegram 交互](./GATEWAY_ENTRY_INTERACTION_DESIGN.md) - 入口层边界、消息机制、`agent_id + session_id` 规范

### runtime/ — Runtime 引擎

- [Chat Runtime 切换](../runtime/chat-runtime-cutover.md) - 灰度切换方案与配置
- [Runtime 集成示例](../runtime/runtime-integration-example.md) - API 层集成 Runtime 示例
- [Runtime 可观测性](../runtime/runtime-observability.md) - 指标监控与运维
- [沙箱安全设计](../runtime/sandbox-security-design.md) - 沙箱隔离架构
- [切换完成报告](../runtime/chat-runtime-completion-report.md) - 切换项目完成报告
- [实施总结](../runtime/chat-runtime-implementation-summary.md) - 实施过程总结
- [验证清单](../runtime/chat-runtime-verification-checklist.md) - 切换验证检查清单

### architecture/ — Skill 架构

- [Skill 定义与包模型](../architecture/skill-definition-package-model.md) - Definition/Package 分层
- [Skill 执行上下文隔离](../architecture/skill-execution-context-isolation.md) - 执行隔离设计
- [Skill 协议兼容性矩阵](../architecture/skill-protocol-compatibility-matrix.md) - 协议兼容性

### operations/ — 运维与操作

- [部署操作指南](../operations/deployment.md) - 部署流程
- [Skill 管理操作指南](../operations/skill-management-operations-guide.md) - Skill 管理
- [管理员账号指南](../operations/admin-guide.md) - 角色体系与管理员创建

### research/ — 调研与分析

- [OpenClaw Agent 范式](../research/openclaw-agent-paradigm.md) - Agent 架构范式详解
- [OpenClaw 对比分析](../research/openclaw-comparison-analysis.md) - 与本项目架构对比
- [OpenClaw 学习总结](../research/OPENCLAW_LEARNINGS.md) - 可借鉴的设计要点

### changelog/ — 阶段总结

- [阶段 A 总结](../changelog/phase-a-summary.md) - Bootstrap 上下文注入
- [阶段 B 总结](../changelog/phase-b-summary.md) - 能力图与 planner 对齐
- [阶段 C 总结](../changelog/phase-c-summary.md) - 统一执行器

### skills/ — Skill 模板

- [Skill 目录模板](../skills/catalog-template/README.md) - 目录结构与配置

### sql/ — 数据库脚本

- [Skill MD Only 迁移](../sql/003_skill_md_only.sql)
- [演进 Skill 表](../sql/014_evolved_skills.sql)
- [演进日志表](../sql/015_evolution_logs.sql)
- [移除版本控制](../sql/remove-skill-version-control.sql)

### user-stories/ — 用户故事

- [PDF 聊天 Skill](../user-stories/chat-pdf-skill.json)
- [Excel 聊天 Skill](../user-stories/chat-xlsx-skill.json)
- [代码审查修复](../user-stories/code-review-50-fixes.json)
- [记忆系统集成](../user-stories/memory-system-integration.json)

## 技术栈

| 层级 | 技术 |
| ---- | ---- |
| 前端 | Next.js 14 (App Router) |
| API 层 | Vercel Serverless Functions |
| Agent Runtime | Python (Modal/Fly.io) |
| 消息队列 | Redis (Upstash) |
| 数据库 | PostgreSQL + pgvector (Supabase) |
| LLM | OpenAI / Anthropic / 多模型适配 |

## 快速开始

```bash
# 克隆项目
git clone https://github.com/your-org/semibot.git

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env.local

# 启动开发服务器
pnpm dev
```

## License

MIT
