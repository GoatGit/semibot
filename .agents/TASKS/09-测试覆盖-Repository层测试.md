# 任务：Repository 层测试

**优先级**: 🔴 P0 - 严重
**类型**: 测试覆盖
**预估工时**: 3-4 天
**影响范围**: 12 个 Repository 文件

---

## 问题描述

Repository 层直接操作数据库，是数据访问的核心层，但**完全缺失测试**。这导致：
1. SQL 查询正确性无法保障
2. 多租户隔离无法验证
3. 软删除逻辑无法验证
4. 分页和排序无法验证

---

## 需要测试的 Repository

| 文件 | 大小 | 关键功能 |
|------|------|----------|
| `agent.repository.ts` | 12KB | Agent CRUD、多租户 |
| `session.repository.ts` | 8KB | 会话管理 |
| `message.repository.ts` | 6KB | 消息存储 |
| `memory.repository.ts` | 10KB | 向量搜索 |
| `skill.repository.ts` | 9KB | Skill 管理、软删除 |
| `skill-definition.repository.ts` | 7KB | Skill 定义 |
| `skill-package.repository.ts` | 8KB | Skill 包管理 |
| `skill-install-log.repository.ts` | 5KB | 安装日志 |
| `mcp.repository.ts` | 7KB | MCP 配置 |
| `tool.repository.ts` | 6KB | Tool 管理 |
| `logs.repository.ts` | 5KB | 日志查询 |
| `llm.repository.ts` | 8KB | LLM 配置 |

---

## 测试策略

### 1. 使用测试数据库

```typescript
// apps/api/src/__tests__/setup.ts

import { sql } from '../lib/db'

// 在测试前创建测试数据库
beforeAll(async () => {
  // 连接测试数据库
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL

  // 运行迁移
  await runMigrations()
})

// 每个测试后清理数据
afterEach(async () => {
  await sql`TRUNCATE agents, sessions, messages, skills, tools CASCADE`
})

// 测试后断开连接
afterAll(async () => {
  await sql.end()
})
```

### 2. 使用 Factory 模式

```typescript
// apps/api/src/__tests__/factories/agent.factory.ts

import { v4 as uuid } from 'uuid'

export function createAgentData(overrides = {}) {
  return {
    id: uuid(),
    orgId: uuid(),
    name: `Test Agent ${Date.now()}`,
    description: 'Test description',
    systemPrompt: 'You are a helpful assistant',
    isActive: true,
    isPublic: false,
    createdBy: uuid(),
    ...overrides
  }
}

export function createOrgData(overrides = {}) {
  return {
    id: uuid(),
    name: `Test Org ${Date.now()}`,
    ...overrides
  }
}

export function createUserData(orgId: string, overrides = {}) {
  return {
    id: uuid(),
    orgId,
    email: `test-${Date.now()}@example.com`,
    name: 'Test User',
    ...overrides
  }
}
```

---

## 测试用例

### 1. Agent Repository 测试

```typescript
// apps/api/src/__tests__/repositories/agent.repository.test.ts

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import * as agentRepository from '../../repositories/agent.repository'
import { createAgentData, createOrgData } from '../factories'
import { sql } from '../../lib/db'

describe('AgentRepository', () => {
  let orgId: string
  let userId: string

  beforeAll(async () => {
    // 创建测试组织和用户
    const org = await sql`INSERT INTO organizations (id, name) VALUES (${uuid()}, 'Test Org') RETURNING id`
    orgId = org[0].id

    const user = await sql`INSERT INTO users (id, org_id, email, name) VALUES (${uuid()}, ${orgId}, 'test@example.com', 'Test') RETURNING id`
    userId = user[0].id
  })

  afterEach(async () => {
    await sql`DELETE FROM agents WHERE org_id = ${orgId}`
  })

  describe('create', () => {
    it('应该成功创建 Agent', async () => {
      const data = createAgentData({ orgId, createdBy: userId })

      const result = await agentRepository.create(data)

      expect(result).toBeDefined()
      expect(result.name).toBe(data.name)
      expect(result.org_id).toBe(orgId)
    })

    it('应该设置默认值', async () => {
      const data = createAgentData({ orgId, createdBy: userId })

      const result = await agentRepository.create(data)

      expect(result.is_active).toBe(true)
      expect(result.version).toBe(1)
      expect(result.created_at).toBeDefined()
    })
  })

  describe('findById', () => {
    it('应该返回存在的 Agent', async () => {
      const data = createAgentData({ orgId, createdBy: userId })
      const created = await agentRepository.create(data)

      const result = await agentRepository.findById(created.id)

      expect(result).toBeDefined()
      expect(result?.id).toBe(created.id)
    })

    it('应该返回 null 如果不存在', async () => {
      const result = await agentRepository.findById(uuid())

      expect(result).toBeNull()
    })

    it('应该不返回已软删除的 Agent', async () => {
      const data = createAgentData({ orgId, createdBy: userId })
      const created = await agentRepository.create(data)
      await agentRepository.softDelete(created.id, orgId, userId)

      const result = await agentRepository.findById(created.id)

      expect(result).toBeNull()
    })
  })

  describe('findByIdAndOrg', () => {
    it('应该只返回属于指定组织的 Agent', async () => {
      const data = createAgentData({ orgId, createdBy: userId })
      const created = await agentRepository.create(data)

      const result = await agentRepository.findByIdAndOrg(created.id, orgId)
      expect(result).toBeDefined()

      // 使用其他 orgId 应该返回 null
      const otherResult = await agentRepository.findByIdAndOrg(created.id, uuid())
      expect(otherResult).toBeNull()
    })
  })

  describe('findByOrg', () => {
    it('应该返回分页结果', async () => {
      // 创建 15 个 Agent
      for (let i = 0; i < 15; i++) {
        await agentRepository.create(createAgentData({ orgId, createdBy: userId }))
      }

      const result = await agentRepository.findByOrg({
        orgId,
        page: 1,
        limit: 10
      })

      expect(result.data).toHaveLength(10)
      expect(result.meta.total).toBe(15)
      expect(result.meta.totalPages).toBe(2)
    })

    it('应该支持搜索', async () => {
      await agentRepository.create(createAgentData({ orgId, createdBy: userId, name: 'Alpha Agent' }))
      await agentRepository.create(createAgentData({ orgId, createdBy: userId, name: 'Beta Agent' }))
      await agentRepository.create(createAgentData({ orgId, createdBy: userId, name: 'Gamma Agent' }))

      const result = await agentRepository.findByOrg({
        orgId,
        search: 'Alpha'
      })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].name).toBe('Alpha Agent')
    })

    it('应该支持 isActive 过滤', async () => {
      await agentRepository.create(createAgentData({ orgId, createdBy: userId, isActive: true }))
      await agentRepository.create(createAgentData({ orgId, createdBy: userId, isActive: false }))

      const activeResult = await agentRepository.findByOrg({ orgId, isActive: true })
      expect(activeResult.data).toHaveLength(1)

      const inactiveResult = await agentRepository.findByOrg({ orgId, isActive: false })
      expect(inactiveResult.data).toHaveLength(1)
    })

    it('应该不返回其他组织的 Agent', async () => {
      const otherOrgId = uuid()
      await sql`INSERT INTO organizations (id, name) VALUES (${otherOrgId}, 'Other Org')`

      await agentRepository.create(createAgentData({ orgId, createdBy: userId }))
      await agentRepository.create(createAgentData({ orgId: otherOrgId, createdBy: userId }))

      const result = await agentRepository.findByOrg({ orgId })

      expect(result.data).toHaveLength(1)
      expect(result.data[0].org_id).toBe(orgId)
    })
  })

  describe('update', () => {
    it('应该更新 Agent', async () => {
      const created = await agentRepository.create(createAgentData({ orgId, createdBy: userId }))

      const result = await agentRepository.update(created.id, orgId, {
        name: 'Updated Name'
      }, userId)

      expect(result?.name).toBe('Updated Name')
      expect(result?.version).toBe(2)  // 版本号应该增加
    })

    it('应该记录 updated_by', async () => {
      const created = await agentRepository.create(createAgentData({ orgId, createdBy: userId }))
      const updaterId = uuid()

      const result = await agentRepository.update(created.id, orgId, {
        name: 'Updated Name'
      }, updaterId)

      expect(result?.updated_by).toBe(updaterId)
    })
  })

  describe('softDelete', () => {
    it('应该软删除 Agent', async () => {
      const created = await agentRepository.create(createAgentData({ orgId, createdBy: userId }))

      const result = await agentRepository.softDelete(created.id, orgId, userId)

      expect(result).toBe(true)

      // 验证已软删除
      const deleted = await sql`SELECT deleted_at, deleted_by FROM agents WHERE id = ${created.id}`
      expect(deleted[0].deleted_at).not.toBeNull()
      expect(deleted[0].deleted_by).toBe(userId)
    })

    it('应该返回 false 如果不存在', async () => {
      const result = await agentRepository.softDelete(uuid(), orgId, userId)

      expect(result).toBe(false)
    })
  })
})
```

### 2. 多租户隔离测试

```typescript
// apps/api/src/__tests__/repositories/multi-tenant.test.ts

import { describe, it, expect, beforeAll } from 'vitest'
import * as agentRepository from '../../repositories/agent.repository'
import * as sessionRepository from '../../repositories/session.repository'
import * as messageRepository from '../../repositories/message.repository'

describe('多租户隔离测试', () => {
  let orgA: string
  let orgB: string
  let userA: string
  let userB: string

  beforeAll(async () => {
    // 创建两个组织
    orgA = await createTestOrg('Org A')
    orgB = await createTestOrg('Org B')
    userA = await createTestUser(orgA)
    userB = await createTestUser(orgB)
  })

  describe('Agent 隔离', () => {
    it('组织 A 不能访问组织 B 的 Agent', async () => {
      const agentB = await agentRepository.create({
        orgId: orgB,
        name: 'Agent B',
        createdBy: userB
      })

      const result = await agentRepository.findByIdAndOrg(agentB.id, orgA)

      expect(result).toBeNull()
    })

    it('findByOrg 只返回本组织的 Agent', async () => {
      await agentRepository.create({ orgId: orgA, name: 'Agent A1', createdBy: userA })
      await agentRepository.create({ orgId: orgA, name: 'Agent A2', createdBy: userA })
      await agentRepository.create({ orgId: orgB, name: 'Agent B1', createdBy: userB })

      const resultA = await agentRepository.findByOrg({ orgId: orgA })
      const resultB = await agentRepository.findByOrg({ orgId: orgB })

      expect(resultA.data.every(a => a.org_id === orgA)).toBe(true)
      expect(resultB.data.every(a => a.org_id === orgB)).toBe(true)
    })
  })

  describe('Session 隔离', () => {
    it('组织 A 不能访问组织 B 的 Session', async () => {
      const sessionB = await sessionRepository.create({
        orgId: orgB,
        userId: userB,
        agentId: await createTestAgent(orgB)
      })

      const result = await sessionRepository.findByIdAndOrg(sessionB.id, orgA)

      expect(result).toBeNull()
    })
  })

  describe('Message 隔离', () => {
    it('组织 A 不能访问组织 B 的 Message', async () => {
      const sessionB = await createTestSession(orgB)
      const messageB = await messageRepository.create({
        sessionId: sessionB,
        role: 'user',
        content: 'Hello'
      })

      const result = await messageRepository.findByIdAndOrg(messageB.id, orgA)

      expect(result).toBeNull()
    })
  })
})
```

### 3. 软删除测试

```typescript
// apps/api/src/__tests__/repositories/soft-delete.test.ts

import { describe, it, expect } from 'vitest'
import * as agentRepository from '../../repositories/agent.repository'
import * as skillRepository from '../../repositories/skill.repository'

describe('软删除测试', () => {
  describe('Agent 软删除', () => {
    it('软删除后 findById 返回 null', async () => {
      const agent = await createTestAgent()
      await agentRepository.softDelete(agent.id, agent.org_id, userId)

      const result = await agentRepository.findById(agent.id)

      expect(result).toBeNull()
    })

    it('软删除后 findByOrg 不包含该记录', async () => {
      const agent = await createTestAgent()
      await agentRepository.softDelete(agent.id, agent.org_id, userId)

      const result = await agentRepository.findByOrg({ orgId: agent.org_id })

      expect(result.data.find(a => a.id === agent.id)).toBeUndefined()
    })

    it('软删除记录 deleted_at 和 deleted_by', async () => {
      const agent = await createTestAgent()
      await agentRepository.softDelete(agent.id, agent.org_id, userId)

      const raw = await sql`SELECT * FROM agents WHERE id = ${agent.id}`

      expect(raw[0].deleted_at).not.toBeNull()
      expect(raw[0].deleted_by).toBe(userId)
    })
  })

  describe('Skill 软删除', () => {
    // 类似的测试...
  })
})
```

---

## 测试目录结构

```
apps/api/src/__tests__/
├── setup.ts                           # 测试设置
├── factories/
│   ├── index.ts
│   ├── agent.factory.ts
│   ├── session.factory.ts
│   ├── skill.factory.ts
│   └── user.factory.ts
├── repositories/
│   ├── agent.repository.test.ts
│   ├── session.repository.test.ts
│   ├── message.repository.test.ts
│   ├── memory.repository.test.ts
│   ├── skill.repository.test.ts
│   ├── skill-definition.repository.test.ts
│   ├── skill-package.repository.test.ts
│   ├── mcp.repository.test.ts
│   ├── tool.repository.test.ts
│   ├── logs.repository.test.ts
│   ├── llm.repository.test.ts
│   ├── multi-tenant.test.ts           # 多租户隔离测试
│   └── soft-delete.test.ts            # 软删除测试
└── utils/
    └── test-helpers.ts
```

---

## 修复清单

### 基础设施
- [ ] 创建 `__tests__/setup.ts` 测试配置
- [ ] 创建 `__tests__/factories/` 工厂函数
- [ ] 配置测试数据库

### Repository 测试（12 个）
- [ ] `agent.repository.test.ts`
- [ ] `session.repository.test.ts`
- [ ] `message.repository.test.ts`
- [ ] `memory.repository.test.ts`
- [ ] `skill.repository.test.ts`
- [ ] `skill-definition.repository.test.ts`
- [ ] `skill-package.repository.test.ts`
- [ ] `skill-install-log.repository.test.ts`
- [ ] `mcp.repository.test.ts`
- [ ] `tool.repository.test.ts`
- [ ] `logs.repository.test.ts`
- [ ] `llm.repository.test.ts`

### 专项测试
- [ ] `multi-tenant.test.ts` - 多租户隔离
- [ ] `soft-delete.test.ts` - 软删除

---

## 完成标准

- [ ] 所有 Repository 都有测试
- [ ] 多租户隔离测试通过
- [ ] 软删除测试通过
- [ ] 测试覆盖率 >= 80%
- [ ] CI 集成通过
- [ ] 代码审查通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [数据库规范](.claude/rules/database.md)
- [安全规范](.claude/rules/security.md)
