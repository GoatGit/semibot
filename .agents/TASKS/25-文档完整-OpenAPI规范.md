# 任务：OpenAPI 规范

**优先级**: 🟡 P1 - 高优先级
**类型**: 文档完整
**预估工时**: 1-2 天
**影响范围**: apps/api/

---

## 问题描述

API 缺少 OpenAPI/Swagger 文档，导致：
1. 前后端对接困难
2. API 使用不清晰
3. 无法自动生成客户端

---

## 实现方案

### 1. 安装依赖

```bash
cd apps/api
pnpm add swagger-jsdoc swagger-ui-express
pnpm add -D @types/swagger-jsdoc @types/swagger-ui-express
```

### 2. 配置 Swagger

```typescript
// apps/api/src/lib/swagger.ts

import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { Express } from 'express'

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Semibot API',
      version: '1.0.0',
      description: 'Semibot AI Agent 平台 API 文档',
      contact: {
        name: 'API Support',
        email: 'support@semibot.ai'
      }
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: '开发服务器'
      },
      {
        url: 'https://api.semibot.ai',
        description: '生产服务器'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'VALIDATION_ERROR' },
                message: { type: 'string', example: '验证失败' },
                details: { type: 'array', items: { type: 'object' } }
              }
            }
          }
        },
        Pagination: {
          type: 'object',
          properties: {
            total: { type: 'integer', example: 100 },
            page: { type: 'integer', example: 1 },
            limit: { type: 'integer', example: 20 },
            totalPages: { type: 'integer', example: 5 }
          }
        }
      }
    },
    security: [{ bearerAuth: [] }]
  },
  apis: ['./src/routes/**/*.ts']
}

const swaggerSpec = swaggerJsdoc(options)

export function setupSwagger(app: Express): void {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
  app.get('/api-docs.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.send(swaggerSpec)
  })
}
```

### 3. 路由注释示例

```typescript
// apps/api/src/routes/v1/agents.ts

/**
 * @swagger
 * components:
 *   schemas:
 *     Agent:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Agent ID
 *         name:
 *           type: string
 *           description: Agent 名称
 *           minLength: 1
 *           maxLength: 100
 *         description:
 *           type: string
 *           description: Agent 描述
 *         systemPrompt:
 *           type: string
 *           description: 系统提示词
 *         isActive:
 *           type: boolean
 *           description: 是否激活
 *         isPublic:
 *           type: boolean
 *           description: 是否公开
 *         createdAt:
 *           type: string
 *           format: date-time
 *           description: 创建时间
 *         updatedAt:
 *           type: string
 *           format: date-time
 *           description: 更新时间
 *
 *     CreateAgentInput:
 *       type: object
 *       required:
 *         - name
 *       properties:
 *         name:
 *           type: string
 *           minLength: 1
 *           maxLength: 100
 *         description:
 *           type: string
 *           maxLength: 1000
 *         systemPrompt:
 *           type: string
 *         isActive:
 *           type: boolean
 *           default: true
 *         isPublic:
 *           type: boolean
 *           default: false
 */

/**
 * @swagger
 * /api/v1/agents:
 *   get:
 *     summary: 获取 Agent 列表
 *     description: 获取当前组织的 Agent 列表，支持分页和搜索
 *     tags:
 *       - Agents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: 每页数量
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: 搜索关键词
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: 过滤激活状态
 *     responses:
 *       200:
 *         description: 成功获取列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Agent'
 *                 meta:
 *                   $ref: '#/components/schemas/Pagination'
 *       401:
 *         description: 未认证
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/', authenticate, asyncHandler(getAgents))

/**
 * @swagger
 * /api/v1/agents/{id}:
 *   get:
 *     summary: 获取 Agent 详情
 *     tags:
 *       - Agents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Agent ID
 *     responses:
 *       200:
 *         description: 成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Agent'
 *       404:
 *         description: Agent 不存在
 */
router.get('/:id', authenticate, asyncHandler(getAgentById))

/**
 * @swagger
 * /api/v1/agents:
 *   post:
 *     summary: 创建 Agent
 *     tags:
 *       - Agents
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentInput'
 *     responses:
 *       201:
 *         description: 创建成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Agent'
 *       400:
 *         description: 验证失败
 */
router.post('/', authenticate, validate(createAgentSchema), asyncHandler(createAgent))

/**
 * @swagger
 * /api/v1/agents/{id}:
 *   put:
 *     summary: 更新 Agent
 *     tags:
 *       - Agents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateAgentInput'
 *     responses:
 *       200:
 *         description: 更新成功
 *       404:
 *         description: Agent 不存在
 *       409:
 *         description: 版本冲突
 */
router.put('/:id', authenticate, validate(updateAgentSchema), asyncHandler(updateAgent))

/**
 * @swagger
 * /api/v1/agents/{id}:
 *   delete:
 *     summary: 删除 Agent
 *     tags:
 *       - Agents
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: 删除成功
 *       404:
 *         description: Agent 不存在
 */
router.delete('/:id', authenticate, asyncHandler(deleteAgent))
```

### 4. 在 app.ts 中启用

```typescript
// apps/api/src/app.ts

import { setupSwagger } from './lib/swagger'

const app = express()

// ... 其他中间件

// Swagger 文档
setupSwagger(app)

// ... 路由
```

---

## 需要添加注释的路由

| 路由文件 | 端点数 | 状态 |
|----------|--------|------|
| `auth.ts` | 5 | ⚠️ 需添加 |
| `agents.ts` | 5 | ⚠️ 需添加 |
| `sessions.ts` | 6 | ⚠️ 需添加 |
| `messages.ts` | 4 | ⚠️ 需添加 |
| `skills.ts` | 8 | ⚠️ 需添加 |
| `tools.ts` | 5 | ⚠️ 需添加 |
| `mcp.ts` | 4 | ⚠️ 需添加 |
| `memories.ts` | 5 | ⚠️ 需添加 |

---

## 修复清单

### 基础设施
- [ ] 安装 swagger-jsdoc 和 swagger-ui-express
- [ ] 创建 `lib/swagger.ts`
- [ ] 在 `app.ts` 中启用 Swagger

### 路由注释
- [ ] 添加 `auth.ts` 注释
- [ ] 添加 `agents.ts` 注释
- [ ] 添加 `sessions.ts` 注释
- [ ] 添加 `messages.ts` 注释
- [ ] 添加 `skills.ts` 注释
- [ ] 添加 `tools.ts` 注释
- [ ] 添加 `mcp.ts` 注释
- [ ] 添加 `memories.ts` 注释

### Schema 定义
- [ ] 定义所有实体 Schema
- [ ] 定义所有 DTO Schema
- [ ] 定义错误响应 Schema

---

## 完成标准

- [ ] 所有 API 端点有文档
- [ ] Swagger UI 可访问
- [ ] Schema 定义完整
- [ ] 示例请求/响应完整
- [ ] 代码审查通过

---

## 相关文档

- [API 规范](.claude/rules/api-standards.md)
- [OpenAPI 规范](https://swagger.io/specification/)
