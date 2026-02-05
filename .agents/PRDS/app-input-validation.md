# PRD: API 路由输入验证

## 概述

当前 API 路由层缺少 Zod schema 验证，用户输入直接进入服务层，存在安全风险。

## 问题描述

- 路由 handlers 未使用 `validate()` 中间件
- 用户输入未经验证直接传给服务
- 存在 SQL 注入、XSS 等安全风险
- `errorHandler.ts` 已支持 Zod 错误处理，但未被使用

## 目标

1. 为所有路由添加 Zod schema 验证
2. 统一验证错误响应格式
3. 防止非法输入进入业务逻辑

## 技术方案

### 1. 创建 Schema 文件

```typescript
// schemas/agent.schema.ts
import { z } from 'zod'

export const createAgentSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    systemPrompt: z.string().max(10000).optional(),
    model: z.string().optional(),
  }),
})

export const updateAgentSchema = z.object({
  params: z.object({
    agentId: z.string().uuid(),
  }),
  body: createAgentSchema.shape.body.partial(),
})
```

### 2. 应用到路由

```typescript
// routes/v1/agents.ts
import { validate } from '@/middleware/errorHandler'
import { createAgentSchema, updateAgentSchema } from '@/schemas/agent.schema'

router.post('/', validate(createAgentSchema), agentController.create)
router.patch('/:agentId', validate(updateAgentSchema), agentController.update)
```

### 3. 需要覆盖的路由

| 路由 | 优先级 |
|------|--------|
| /auth/* | P0 - 认证相关 |
| /agents/* | P0 |
| /sessions/* | P0 |
| /chat/* | P0 |
| /api-keys/* | P1 |
| /organizations/* | P1 |
| /skills/* | P1 |
| /tools/* | P1 |
| /mcp/* | P1 |
| /memory/* | P2 |
| /logs/* | P2 |

## 验收标准

- [ ] 所有路由都有对应的 Zod schema
- [ ] 无效输入返回 400 错误和详细字段信息
- [ ] 通过安全测试（SQL 注入、XSS 尝试被拒绝）
- [ ] 验证规则与数据库约束一致

## 优先级

**P0 - 阻塞性** - 安全漏洞

## 相关文件

- `apps/api/src/routes/v1/*.ts`
- `apps/api/src/schemas/*.ts` (新建目录)
- `apps/api/src/middleware/errorHandler.ts`
