# 任务：修复 API 字段命名（snake_case）

**优先级**: 🟡 P1 - 高优先级
**类型**: API 规范
**预估工时**: 0.5-1 小时
**影响范围**: 1 个文件

---

## 问题描述

`/auth/register` 接口使用 `org_name` (snake_case) 字段，违反了 API 规范。所有 API 字段应使用 camelCase 命名。

---

## 规范要求

根据 `.claude/rules/api-standards.md`:

**统一使用 camelCase**，禁止 snake_case。

```typescript
// ✅ 正确
{ userId, createdAt, refreshToken, expiresAt }

// ❌ 错误
{ user_id, created_at, refresh_token, expires_at }
```

---

## 违规位置

**文件**: `apps/api/src/routes/v1/auth.ts:24`

```typescript
// ❌ 错误 - 使用 snake_case
const registerSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
  name: z.string().min(1, '姓名不能为空').max(100, '姓名最长100字符'),
  org_name: z.string().min(1, '组织名称不能为空').max(100, '组织名称最长100字符'), // ❌
})

// 当前的手动转换 (auth.ts:96-102)
const { email, password, name, org_name } = validation.data

const result = await authService.register({
  email,
  password,
  name,
  orgName: org_name,  // 手动转换
})
```

---

## 修复方案

### 1. 修改 Zod Schema

```typescript
// ✅ 正确 - 使用 camelCase
const registerSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
  name: z.string().min(1, '姓名不能为空').max(100, '姓名最长100字符'),
  orgName: z.string().min(1, '组织名称不能为空').max(100, '组织名称最长100字符'), // ✅
})
```

### 2. 简化 Service 调用

```typescript
// ✅ 直接使用，无需转换
const { email, password, name, orgName } = validation.data

const result = await authService.register({
  email,
  password,
  name,
  orgName,  // 直接使用
})
```

---

## 完整修复代码

```typescript
// apps/api/src/routes/v1/auth.ts

import { z } from 'zod'
import { Router } from 'express'
import { validate, asyncHandler } from '../../middleware/errorHandler'
import * as authService from '../../services/auth.service'

const router = Router()

// ✅ 修复后的 Schema
const registerSchema = z.object({
  email: z.string().email('邮箱格式无效'),
  password: z.string().min(8, '密码至少8位').max(100, '密码最长100位'),
  name: z.string().min(1, '姓名不能为空').max(100, '姓名最长100字符'),
  orgName: z.string().min(1, '组织名称不能为空').max(100, '组织名称最长100字符'),
})

/**
 * POST /api/v1/auth/register
 * 用户注册
 */
router.post(
  '/register',
  validate(registerSchema, 'body'),
  asyncHandler(async (req, res) => {
    const { email, password, name, orgName } = req.body

    const result = await authService.register({
      email,
      password,
      name,
      orgName,
    })

    res.status(201).json({
      success: true,
      data: result,
    })
  })
)

export default router
```

---

## 前端适配

如果前端已经使用 `org_name`，需要同步修改：

```typescript
// ❌ 修改前
const response = await fetch('/api/v1/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email,
    password,
    name,
    org_name: orgName,  // ❌
  })
})

// ✅ 修改后
const response = await fetch('/api/v1/auth/register', {
  method: 'POST',
  body: JSON.stringify({
    email,
    password,
    name,
    orgName,  // ✅
  })
})
```

---

## 测试验证

### 1. 单元测试
```typescript
describe('POST /api/v1/auth/register', () => {
  it('应该接受 camelCase 字段', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
        orgName: 'Test Org',  // ✅ camelCase
      })

    expect(response.status).toBe(201)
    expect(response.body.success).toBe(true)
  })

  it('应该拒绝 snake_case 字段', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User',
        org_name: 'Test Org',  // ❌ snake_case
      })

    expect(response.status).toBe(400)
    expect(response.body.success).toBe(false)
  })
})
```

### 2. API 文档更新
更新 `docs/design/API_DESIGN.md` 中的注册接口示例：

```markdown
### POST /api/v1/auth/register

**请求体**:
```json
{
  "email": "user@example.com",
  "password": "securePassword123",
  "name": "张三",
  "orgName": "示例公司"  // ✅ 使用 camelCase
}
```
```

---

## 修复清单

- [ ] 修改 `registerSchema` 中的 `org_name` 为 `orgName`
- [ ] 简化 Service 调用（移除手动转换）
- [ ] 更新前端代码（如需要）
- [ ] 更新 API 文档
- [ ] 添加单元测试
- [ ] 运行测试验证
- [ ] 代码审查

---

## 影响评估

### 向后兼容性
- **破坏性变更**: 是
- **影响范围**: 注册接口的前端调用
- **迁移策略**:
  1. 同时支持两种格式（临时）
  2. 前端更新后移除旧格式支持

### 临时兼容方案（可选）
```typescript
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(100),
  name: z.string().min(1).max(100),
  orgName: z.string().min(1).max(100).optional(),
  org_name: z.string().min(1).max(100).optional(),  // 临时支持
}).refine(
  (data) => data.orgName || data.org_name,
  { message: '组织名称不能为空' }
)

// 处理逻辑
const orgName = validation.data.orgName || validation.data.org_name
```

---

## 完成标准

- [ ] API 字段使用 camelCase
- [ ] 前端代码已同步更新
- [ ] API 文档已更新
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 代码审查通过

---

## 相关文档

- [API 规范 - 字段命名](.claude/rules/api-standards.md#字段命名)
- [API 设计文档](docs/design/API_DESIGN.md)
