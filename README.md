# Semibot - 通用 Agent 编排平台

> 极简的云原生 Agent 编排平台，支持多 LLM、Skill 扩展和 MCP 集成

## 特性

- **多 LLM 支持** - OpenAI、Anthropic、Google 等主流 LLM
- **Skill 系统** - 可扩展的 Skill 注册表，支持版本管理
- **MCP 集成** - Model Context Protocol 客户端
- **智能记忆** - 短期（Redis）+ 长期（PostgreSQL + pgvector）
- **多租户** - 完整的租户隔离和配额管理
- **实时通信** - SSE/WebSocket 实时状态推送
- **沙箱执行** - Docker 隔离的代码执行环境
- **审计日志** - 完整的执行追踪和审计

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                        Web Frontend                          │
│                  (Next.js 14 + React 18)                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         API Layer                            │
│                  (Node.js + Express + TypeScript)            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Runtime Engine                          │
│              (Python + LangGraph + LangChain)                │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
          ┌──────────────┐    ┌──────────────┐
          │  PostgreSQL  │    │    Redis     │
          │  + pgvector  │    │   (Cache)    │
          └──────────────┘    └──────────────┘
```

## 项目结构

```
semibot/
├── apps/
│   ├── api/              # Express API 服务 (TypeScript)
│   └── web/              # Next.js 前端应用 (React)
├── packages/
│   ├── shared-types/     # 共享 TypeScript 类型
│   ├── shared-config/    # 共享配置
│   └── ui/               # UI 组件库
├── runtime/              # Python Agent Runtime 引擎
├── database/             # 数据库迁移和脚本
├── infra/                # 基础设施配置
├── docs/                 # 项目文档
└── tests/                # E2E 测试
```

## 技术栈

### 前端
- **框架**: Next.js 14 (App Router)
- **UI**: React 18 + Tailwind CSS
- **状态管理**: Zustand
- **测试**: Vitest + Playwright

### 后端 API
- **运行时**: Node.js 20+
- **框架**: Express + TypeScript
- **数据库**: PostgreSQL 15+ (pgvector)
- **缓存**: Redis 7+ (ioredis)
- **验证**: Zod
- **测试**: Vitest

### Runtime 引擎
- **语言**: Python 3.11+
- **框架**: LangGraph + LangChain
- **LLM**: OpenAI, Anthropic, Google
- **测试**: pytest

## 快速开始

### 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- PostgreSQL 15+
- Redis 7+
- Python 3.11+
- Docker (可选，用于沙箱)

### 安装

```bash
# 1. 克隆项目
git clone https://github.com/your-org/semibot.git
cd semibot

# 2. 安装 Node.js 依赖
pnpm install

# 3. 设置 Python 环境（Runtime 引擎）
# 确保安装了 Python 3.11+
python3.11 --version  # 如果没有，使用 brew install python@3.11

# 创建虚拟环境
cd runtime
python3.11 -m venv .venv

# 激活虚拟环境并安装依赖
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -e .

# 安装额外依赖
pip install "aiohttp>=3.9.0" "docker>=7.0.0" "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.30.0" "sse-starlette>=2.1.0" \
    "opentelemetry-exporter-otlp>=1.26.0"

# 安装 MCP SDK（从 GitHub）
pip install "mcp @ git+https://github.com/modelcontextprotocol/python-sdk.git"

cd ..

# 4. 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填入配置

# 5. 启动数据库
docker-compose up -d postgres redis

# 6. 运行数据库迁移
cd database
psql -U postgres -d semibot -f migrations/001_init_schema.sql

# 7. 启动开发服务器
pnpm dev
```

### 访问应用

- **Web 前端**: http://localhost:3100
- **API 服务**: http://localhost:3101
- **API 文档**: http://localhost:3101/api-docs

## 常用命令

```bash
pnpm dev        # 开发模式
pnpm build      # 构建
pnpm test       # 运行测试
pnpm lint       # 代码检查
pnpm typecheck  # 类型检查
pnpm format     # 代码格式化

# 单独启动
pnpm --filter api dev    # API 服务
pnpm --filter web dev    # Web 应用

# Runtime 测试
cd runtime && pytest
```

## 文档

### 核心文档
- [架构设计](docs/design/ARCHITECTURE.md)
- [API 设计](docs/design/API_DESIGN.md)
- [数据模型](docs/design/DATA_MODEL.md)
- [部署指南](docs/design/DEPLOYMENT.md)
- [测试指南](docs/design/TESTING.md)

### 开发规范
- [编码规范](.claude/rules/coding-standards.md)
- [API 规范](.claude/rules/api-standards.md)
- [数据库规范](.claude/rules/database.md)
- [安全规范](.claude/rules/security.md)
- [并发规范](.claude/rules/concurrency.md)

### Runtime 文档
- [Runtime 架构](runtime/docs/architecture.md)
- [API 参考](runtime/docs/api-reference.md)
- [部署指南](runtime/docs/deployment-guide.md)

## 贡献

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 许可证

Private - All Rights Reserved
