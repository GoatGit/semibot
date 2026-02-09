# 任务：子模块 README

**优先级**: 🟡 P1 - 高优先级
**类型**: 文档完整
**预估工时**: 1 天
**影响范围**: 多个子目录

---

## 问题描述

各子模块（apps/api, apps/web, runtime, packages/*）缺少独立的 README 文件，导致：
1. 新成员难以理解各模块职责
2. 本地开发配置不清晰
3. 模块间依赖关系不明确

---

## 需要创建的 README

| 位置 | 模块 | 状态 |
|------|------|------|
| `apps/api/README.md` | API 服务 | ⚠️ 缺失 |
| `apps/web/README.md` | Web 前端 | ⚠️ 缺失 |
| `runtime/README.md` | Python Runtime | ✅ 已有 |
| `packages/shared-types/README.md` | 共享类型 | ⚠️ 缺失 |
| `packages/ui/README.md` | UI 组件库 | ⚠️ 缺失 |

---

## README 模板

### 1. API 服务 README

```markdown
# Semibot API

后端 API 服务，基于 Node.js + Express + TypeScript。

## 技术栈

- **运行时**: Node.js 18+
- **框架**: Express 4.x
- **语言**: TypeScript 5.x
- **数据库**: PostgreSQL 15+ with pgvector
- **缓存**: Redis 7+
- **ORM**: 原生 SQL (postgres.js)

## 目录结构

```
src/
├── routes/           # API 路由
│   └── v1/           # v1 版本路由
├── services/         # 业务逻辑层
├── repositories/     # 数据访问层
├── middlewares/      # 中间件
├── lib/              # 工具库
├── constants/        # 常量定义
└── types/            # 类型定义
```

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- PostgreSQL >= 15
- Redis >= 7

### 安装依赖

```bash
pnpm install
```

### 环境变量

复制 `.env.example` 到 `.env` 并配置：

```bash
cp .env.example .env
```

必需的环境变量：

| 变量 | 说明 | 示例 |
|------|------|------|
| DATABASE_URL | PostgreSQL 连接字符串 | postgresql://user:pass@localhost:5432/semibot |
| REDIS_URL | Redis 连接字符串 | redis://localhost:6379 |
| JWT_SECRET | JWT 签名密钥 | your-secret-key |
| PORT | API 端口 | 3001 |

### 运行开发服务器

```bash
pnpm dev
```

### 运行测试

```bash
pnpm test
```

### 构建

```bash
pnpm build
```

## API 文档

启动服务后访问：`http://localhost:3001/api-docs`

## 依赖关系

- 依赖 `@semibot/shared-types` - 共享类型定义
- 被 `apps/web` 调用 - 前端应用

## 开发规范

- [编码规范](../../.claude/rules/coding-standards.md)
- [API 规范](../../.claude/rules/api-standards.md)
- [数据库规范](../../.claude/rules/database.md)
```

### 2. Web 前端 README

```markdown
# Semibot Web

前端 Web 应用，基于 Next.js 14 + React 18。

## 技术栈

- **框架**: Next.js 14 (App Router)
- **UI**: React 18 + Tailwind CSS
- **状态管理**: Zustand
- **表单**: React Hook Form + Zod
- **请求**: Fetch API + SWR

## 目录结构

```
app/
├── (auth)/           # 认证相关页面
│   ├── login/
│   └── register/
├── (dashboard)/      # 主应用页面
│   ├── agents/
│   ├── sessions/
│   └── settings/
├── api/              # API Routes
└── layout.tsx        # 根布局

components/           # 组件
├── ui/               # 基础 UI 组件
├── forms/            # 表单组件
└── layouts/          # 布局组件

lib/                  # 工具库
├── api/              # API 客户端
├── hooks/            # 自定义 Hooks
└── utils/            # 工具函数

stores/               # Zustand stores
```

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### 安装依赖

```bash
pnpm install
```

### 环境变量

复制 `.env.example` 到 `.env.local`：

```bash
cp .env.example .env.local
```

| 变量 | 说明 | 示例 |
|------|------|------|
| NEXT_PUBLIC_API_URL | API 服务地址 | http://localhost:3001 |
| NEXT_PUBLIC_APP_NAME | 应用名称 | Semibot |

### 运行开发服务器

```bash
pnpm dev
```

访问 `http://localhost:3000`

### 运行测试

```bash
pnpm test
```

### 构建

```bash
pnpm build
```

## 依赖关系

- 依赖 `@semibot/shared-types` - 共享类型
- 依赖 `@semibot/ui` - UI 组件库
- 调用 `apps/api` - 后端 API

## 开发规范

- [编码规范](../../.claude/rules/coding-standards.md)
- 组件使用 PascalCase
- Hooks 使用 camelCase 前缀 `use`
```

### 3. 共享类型 README

```markdown
# @semibot/shared-types

前后端共享的 TypeScript 类型定义。

## 安装

```bash
pnpm add @semibot/shared-types
```

## 使用

```typescript
import { Agent, CreateAgentInput, AgentResponse } from '@semibot/shared-types'

// 使用类型
const agent: Agent = { ... }
```

## 目录结构

```
src/
├── entities/         # 实体类型
│   ├── agent.ts
│   ├── session.ts
│   └── ...
├── dto/              # DTO 类型
│   ├── agent.dto.ts
│   └── ...
├── api/              # API 响应类型
│   └── response.ts
└── index.ts          # 导出入口
```

## 类型命名规范

| 类型 | 命名格式 | 示例 |
|------|----------|------|
| 实体 | `Xxx` | `Agent` |
| 创建 DTO | `CreateXxxInput` | `CreateAgentInput` |
| 更新 DTO | `UpdateXxxInput` | `UpdateAgentInput` |
| API 响应 | `XxxResponse` | `AgentResponse` |

## 开发

```bash
# 构建
pnpm build

# 类型检查
pnpm typecheck
```
```

### 4. UI 组件库 README

```markdown
# @semibot/ui

共享 UI 组件库，基于 Tailwind CSS。

## 安装

```bash
pnpm add @semibot/ui
```

## 使用

```tsx
import { Button, Input, Modal } from '@semibot/ui'

export function MyComponent() {
  return (
    <div>
      <Button variant="primary">Click me</Button>
      <Input placeholder="Enter text" />
    </div>
  )
}
```

## 组件列表

### 基础组件

- `Button` - 按钮
- `Input` - 输入框
- `Select` - 下拉选择
- `Checkbox` - 复选框
- `Radio` - 单选框

### 反馈组件

- `Modal` - 弹窗
- `Toast` - 提示
- `Loading` - 加载状态
- `Skeleton` - 骨架屏

### 布局组件

- `Card` - 卡片
- `Grid` - 网格
- `Stack` - 堆叠

## 开发

```bash
# 启动 Storybook
pnpm storybook

# 构建
pnpm build
```

## 主题配置

组件支持 Tailwind CSS 主题定制，参考 `tailwind.config.js`。
```

---

## 修复清单

### README 文件
- [ ] 创建 `apps/api/README.md`
- [ ] 创建 `apps/web/README.md`
- [ ] 检查 `runtime/README.md`
- [ ] 创建 `packages/shared-types/README.md`
- [ ] 创建 `packages/ui/README.md`

### 内容要求
- [ ] 技术栈说明
- [ ] 目录结构
- [ ] 快速开始指南
- [ ] 环境变量说明
- [ ] 依赖关系
- [ ] 开发规范链接

---

## 完成标准

- [ ] 所有子模块都有 README
- [ ] README 内容完整
- [ ] 快速开始指南可执行
- [ ] 代码审查通过

---

## 相关文档

- [项目根 README](../../README.md)
- [编码规范](../../.claude/rules/coding-standards.md)
