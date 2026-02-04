# 部署指南

## 1. 架构概览

```text
┌─────────────────────────────────────────────────────────────┐
│                        Production                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐ │
│  │   Vercel    │    │Modal/Fly.io │    │    Supabase     │ │
│  │  Frontend   │    │   Python    │    │   PostgreSQL    │ │
│  │  + API      │    │   Runtime   │    │   + pgvector    │ │
│  └─────────────┘    └─────────────┘    └─────────────────┘ │
│         │                  │                    │          │
│         └────────┬─────────┴────────────────────┘          │
│                  │                                          │
│           ┌──────┴──────┐                                   │
│           │   Upstash   │                                   │
│           │   Redis     │                                   │
│           └─────────────┘                                   │
└─────────────────────────────────────────────────────────────┘

## 1.1 环境划分

- **Dev**: 本地 Docker Compose + 本地环境变量
- **Staging**: 独立数据库与 Redis，用于发布前验证
- **Prod**: 生产环境，启用监控/告警/备份
```

## 2. 环境要求

| 组件 | 版本要求 |
| ---- | -------- |
| Node.js | >= 18.0 |
| Python | >= 3.11 |
| pnpm | >= 8.0 |
| Docker | >= 24.0 (可选，本地开发) |

## 3. 云服务配置

### 3.1 Vercel (前端 + API)

```bash
# 安装 Vercel CLI
pnpm add -g vercel

# 登录
vercel login

# 部署
vercel --prod
```

**vercel.json** 配置:

```json
{
  "framework": "nextjs",
  "regions": ["hkg1", "sin1"],
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

### 3.2 Supabase (PostgreSQL + pgvector)

1. 创建项目: <https://supabase.com/dashboard>
2. 启用 pgvector 扩展:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

1. 运行数据库迁移 (详见第5节)

### 3.3 Upstash (Redis)

1. 创建 Redis 实例: <https://console.upstash.com>
2. 选择区域 (推荐与 Vercel 同区域)
3. 获取连接 URL

### 3.4 Modal (Python Runtime)

```bash
# 安装 Modal CLI
pip install modal

# 登录
modal setup

# 部署
modal deploy runtime/main.py
```

## 4. 环境变量

### .env.example

```bash
# ===== Database =====
DATABASE_URL=postgresql://user:pass@db.supabase.co:5432/postgres
DIRECT_URL=postgresql://user:pass@db.supabase.co:5432/postgres

# ===== Redis =====
REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379

# ===== LLM Providers =====
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx

# ===== Auth =====
JWT_SECRET=your-secret-key
API_KEY_SALT=your-salt

# ===== Modal (Python Runtime) =====
MODAL_TOKEN_ID=xxx
MODAL_TOKEN_SECRET=xxx

# ===== Optional =====
SENTRY_DSN=https://xxx@sentry.io/xxx
```

## 5. 数据库迁移

### 迁移文件结构

```text
infra/migrations/
├── 001_init.sql               # 初始化扩展和函数（pgvector、update_updated_at）
├── 002_organizations.sql      # organizations 表
├── 003_users.sql              # users 表
├── 004_api_keys.sql           # api_keys 表
├── 005_agents.sql             # agents 表
├── 006_agent_versions.sql     # agent_versions 表
├── 007_skills.sql             # skills 表
├── 008_tools.sql              # tools 表
├── 009_sessions.sql           # sessions 表
├── 010_messages.sql           # messages 表
├── 011_memories.sql           # memories 表
├── 012_execution_logs.sql     # execution_logs 表
└── 013_usage_logs.sql         # usage_logs 表
```

### 执行迁移

```bash
# 使用 Supabase CLI
supabase db push

# 或手动执行（按顺序）
for f in infra/migrations/*.sql; do
  psql $DATABASE_URL -f "$f"
done

# 或逐个执行
psql $DATABASE_URL -f infra/migrations/001_init.sql
psql $DATABASE_URL -f infra/migrations/002_organizations.sql
psql $DATABASE_URL -f infra/migrations/003_users.sql
# ... 依次执行到 013_usage_logs.sql
```

## 6. 本地开发

### Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    image: pgvector/pgvector:pg16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: semibot
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  postgres_data:
```

### 启动开发环境

```bash
# 启动数据库服务
docker-compose up -d

# 安装依赖
pnpm install

# 运行迁移
pnpm db:migrate

# 启动开发服务器
pnpm dev

## 6.1 运行时扩缩容建议

- **Modal**: 按任务并发数自动扩容，设置最大并发上限防止成本失控
- **Fly.io**: min=1, max=10，超时自动缩容
- **Redis**: 预留高峰期内存与连接数上限
```

## 7. CI/CD

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy-web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'

  deploy-runtime:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      
      - name: Deploy to Modal
        run: |
          pip install modal
          modal deploy runtime/main.py
        env:
          MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}
          MODAL_TOKEN_SECRET: ${{ secrets.MODAL_TOKEN_SECRET }}
```

## 8. 监控与日志

### 8.1 Vercel Analytics

在 `next.config.js` 启用:

```javascript
module.exports = {
  experimental: {
    instrumentationHook: true
  }
}
```

### 8.2 Sentry (错误追踪)

```bash
pnpm add @sentry/nextjs
npx @sentry/wizard@latest -i nextjs
```

### 8.3 关键指标

| 指标 | 告警阈值 |
| ---- | -------- |
| API 响应时间 | > 5s |
| 错误率 | > 1% |
| Agent 执行时间 | > 60s |
| Redis 内存 | > 80% |
| 数据库连接数 | > 80 |

## 9. 安全清单

- [ ] 启用 HTTPS (Vercel 默认)
- [ ] 配置 CORS 白名单
- [ ] API Key 加密存储
- [ ] 敏感环境变量使用 Secrets
- [ ] 启用 WAF (可选)
- [ ] 定期轮换密钥

## 10. 发布回滚

- **Web/API**: 回滚到上一个 Vercel 部署
- **Runtime**: 回滚到上一个 Modal/Fly 镜像版本
- **DB**: 迁移回滚仅限可逆脚本；不可逆变更需预备数据恢复方案
