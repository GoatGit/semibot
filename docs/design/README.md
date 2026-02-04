# Semibot - 通用 Agent 平台

## 概述

Semibot 是一个极简的云原生 Agent 编排平台，让开发者能够快速构建、部署和管理 AI 智能体。

## 设计原则

1. **极简架构** - 最少的组件，最大的灵活性
2. **云原生** - Serverless 优先，按需扩缩容
3. **前后端分离** - 独立部署，独立演进
4. **多语言协作** - Node.js API 层 + Python Runtime
5. **可组合** - Agent、Skill、Tool 自由组合

## 核心概念

| 概念 | 定义 |
| ---- | ---- |
| **Agent** | 具有角色、目标、记忆的智能体实例 |
| **SubAgent** | 被父 Agent 编排调用的子智能体 |
| **Skill** | Agent 可调用的能力单元（封装一组 Tools） |
| **Tool** | 最小执行单元（API调用、代码执行、数据查询） |
| **Memory** | 短期(对话) + 长期(向量) 记忆系统 |
| **Session** | 一次完整的用户交互会话 |

## 文档目录

- [架构设计](./ARCHITECTURE.md) - 系统整体架构
- [数据模型](./DATA_MODEL.md) - 数据库设计
- [API 设计](./API_DESIGN.md) - 接口规范
- [Agent Runtime](./AGENT_RUNTIME.md) - Python 执行引擎
- [部署指南](./DEPLOYMENT.md) - 部署配置

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
