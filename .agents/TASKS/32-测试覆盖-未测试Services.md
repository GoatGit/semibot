# 任务：未测试 Services 测试

**优先级**: 🟢 P2 - 中优先级
**类型**: 测试覆盖
**预估工时**: 2-3 天
**影响范围**: apps/api/src/services/

---

## 问题描述

多个 Service 缺少测试覆盖，无法保证业务逻辑正确性。

---

## 需要测试的 Service

| Service | 大小 | 测试状态 |
|---------|------|----------|
| `agent.service.ts` | 15KB | ⚠️ 部分测试 |
| `session.service.ts` | 12KB | ⚠️ 缺少测试 |
| `message.service.ts` | 8KB | ⚠️ 缺少测试 |
| `skill.service.ts` | 18KB | ⚠️ 部分测试 |
| `skill-install.service.ts` | 10KB | ⚠️ 缺少测试 |
| `tool.service.ts` | 8KB | ⚠️ 缺少测试 |
| `mcp.service.ts` | 10KB | ⚠️ 缺少测试 |
| `memory.service.ts` | 12KB | ⚠️ 缺少测试 |
| `auth.service.ts` | 15KB | ⚠️ 部分测试 |

---

## 测试用例

### 1. Session Service 测试

```typescript
// apps/api/src/__tests__/services/session.service.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as sessionService from '../../services/session.service'
import * as sessionRepository from '../../repositories/session.repository'
import * as agentRepository from '../../repositories/agent.repository'

vi.mock('../../repositories/session.repository')
vi.mock('../../repositories/agent.repository')

describe('SessionService', () => {
  const mockOrgId = 'org-1'
  const mockUserId = 'user-1'
  const mockAgentId = 'agent-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSession', () => {
    it('应该成功创建 Session', async () => {
      const mockAgent = { id: mockAgentId, orgId: mockOrgId }
      const mockSession = { id: 'session-1', agentId: mockAgentId }

      vi.mocked(agentRepository.findByIdAndOrg).mockResolvedValue(mockAgent)
      vi.mocked(sessionRepository.create).mockResolvedValue(mockSession)

      const result = await sessionService.createSession(mockOrgId, mockUserId, {
        agentId: mockAgentId
      })

      expect(result.id).toBe('session-1')
      expect(sessionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          userId: mockUserId,
          agentId: mockAgentId
        })
      )
    })

    it('Agent 不存在应该抛出错误', async () => {
      vi.mocked(agentRepository.findByIdAndOrg).mockResolvedValue(null)

      await expect(
        sessionService.createSession(mockOrgId, mockUserId, { agentId: mockAgentId })
      ).rejects.toThrow('AGENT_NOT_FOUND')
    })

    it('超过配额应该抛出错误', async () => {
      const mockAgent = { id: mockAgentId, orgId: mockOrgId }
      vi.mocked(agentRepository.findByIdAndOrg).mockResolvedValue(mockAgent)
      vi.mocked(sessionRepository.countByOrg).mockResolvedValue(1000)

      await expect(
        sessionService.createSession(mockOrgId, mockUserId, { agentId: mockAgentId })
      ).rejects.toThrow('QUOTA_EXCEEDED')
    })
  })

  describe('getSessionById', () => {
    it('存在时应该返回 Session', async () => {
      const mockSession = { id: 'session-1', orgId: mockOrgId }
      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(mockSession)

      const result = await sessionService.getSessionById('session-1', mockOrgId)

      expect(result.id).toBe('session-1')
    })

    it('不存在时应该抛出错误', async () => {
      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(null)

      await expect(
        sessionService.getSessionById('session-1', mockOrgId)
      ).rejects.toThrow('SESSION_NOT_FOUND')
    })
  })

  describe('listSessions', () => {
    it('应该返回分页结果', async () => {
      const mockResult = {
        data: [{ id: 'session-1' }, { id: 'session-2' }],
        meta: { total: 10, page: 1, limit: 20, totalPages: 1 }
      }
      vi.mocked(sessionRepository.findByOrg).mockResolvedValue(mockResult)

      const result = await sessionService.listSessions(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(2)
      expect(result.meta.total).toBe(10)
    })

    it('应该支持按 Agent 过滤', async () => {
      await sessionService.listSessions(mockOrgId, { agentId: mockAgentId })

      expect(sessionRepository.findByOrg).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: mockAgentId })
      )
    })
  })

  describe('deleteSession', () => {
    it('应该软删除 Session', async () => {
      vi.mocked(sessionRepository.softDelete).mockResolvedValue(true)

      await sessionService.deleteSession('session-1', mockOrgId, mockUserId)

      expect(sessionRepository.softDelete).toHaveBeenCalledWith(
        'session-1',
        mockOrgId,
        mockUserId
      )
    })

    it('Session 不存在应该抛出错误', async () => {
      vi.mocked(sessionRepository.softDelete).mockResolvedValue(false)

      await expect(
        sessionService.deleteSession('session-1', mockOrgId, mockUserId)
      ).rejects.toThrow('SESSION_NOT_FOUND')
    })
  })
})
```

### 2. Message Service 测试

```typescript
// apps/api/src/__tests__/services/message.service.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as messageService from '../../services/message.service'
import * as messageRepository from '../../repositories/message.repository'
import * as sessionRepository from '../../repositories/session.repository'

vi.mock('../../repositories/message.repository')
vi.mock('../../repositories/session.repository')

describe('MessageService', () => {
  const mockOrgId = 'org-1'
  const mockSessionId = 'session-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createMessage', () => {
    it('应该创建用户消息', async () => {
      const mockSession = { id: mockSessionId, orgId: mockOrgId }
      const mockMessage = { id: 'msg-1', role: 'user', content: 'Hello' }

      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(mockSession)
      vi.mocked(messageRepository.create).mockResolvedValue(mockMessage)

      const result = await messageService.createMessage(mockSessionId, mockOrgId, {
        role: 'user',
        content: 'Hello'
      })

      expect(result.id).toBe('msg-1')
      expect(result.role).toBe('user')
    })

    it('Session 不存在应该抛出错误', async () => {
      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(null)

      await expect(
        messageService.createMessage(mockSessionId, mockOrgId, {
          role: 'user',
          content: 'Hello'
        })
      ).rejects.toThrow('SESSION_NOT_FOUND')
    })

    it('空内容应该抛出错误', async () => {
      const mockSession = { id: mockSessionId, orgId: mockOrgId }
      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(mockSession)

      await expect(
        messageService.createMessage(mockSessionId, mockOrgId, {
          role: 'user',
          content: ''
        })
      ).rejects.toThrow('EMPTY_CONTENT')
    })
  })

  describe('getMessages', () => {
    it('应该返回消息列表', async () => {
      const mockSession = { id: mockSessionId, orgId: mockOrgId }
      const mockMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi!' }
      ]

      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(mockSession)
      vi.mocked(messageRepository.findBySession).mockResolvedValue(mockMessages)

      const result = await messageService.getMessages(mockSessionId, mockOrgId)

      expect(result).toHaveLength(2)
    })

    it('应该支持分页', async () => {
      const mockSession = { id: mockSessionId, orgId: mockOrgId }
      vi.mocked(sessionRepository.findByIdAndOrg).mockResolvedValue(mockSession)

      await messageService.getMessages(mockSessionId, mockOrgId, {
        limit: 10,
        before: 'msg-10'
      })

      expect(messageRepository.findBySession).toHaveBeenCalledWith(
        mockSessionId,
        expect.objectContaining({ limit: 10, before: 'msg-10' })
      )
    })
  })
})
```

### 3. Memory Service 测试

```typescript
// apps/api/src/__tests__/services/memory.service.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as memoryService from '../../services/memory.service'
import * as memoryRepository from '../../repositories/memory.repository'

vi.mock('../../repositories/memory.repository')

describe('MemoryService', () => {
  const mockOrgId = 'org-1'
  const mockAgentId = 'agent-1'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('saveMemory', () => {
    it('应该保存记忆', async () => {
      const mockMemory = { id: 'mem-1', content: 'Important info' }
      vi.mocked(memoryRepository.create).mockResolvedValue(mockMemory)

      const result = await memoryService.saveMemory(mockOrgId, mockAgentId, {
        content: 'Important info',
        metadata: { type: 'fact' }
      })

      expect(result.id).toBe('mem-1')
    })

    it('超过配额应该删除旧记忆', async () => {
      vi.mocked(memoryRepository.countByAgent).mockResolvedValue(10000)
      vi.mocked(memoryRepository.create).mockResolvedValue({ id: 'mem-new' })

      await memoryService.saveMemory(mockOrgId, mockAgentId, {
        content: 'New info'
      })

      expect(memoryRepository.deleteOldest).toHaveBeenCalledWith(
        mockAgentId,
        expect.any(Number)
      )
    })
  })

  describe('searchMemories', () => {
    it('应该返回相似记忆', async () => {
      const mockMemories = [
        { id: 'mem-1', content: 'Related info', similarity: 0.9 }
      ]
      vi.mocked(memoryRepository.searchSimilar).mockResolvedValue(mockMemories)

      const result = await memoryService.searchMemories(mockOrgId, mockAgentId, {
        query: 'info',
        limit: 5
      })

      expect(result).toHaveLength(1)
      expect(result[0].similarity).toBe(0.9)
    })

    it('应该过滤低相似度结果', async () => {
      const mockMemories = [
        { id: 'mem-1', content: 'High', similarity: 0.9 },
        { id: 'mem-2', content: 'Low', similarity: 0.3 }
      ]
      vi.mocked(memoryRepository.searchSimilar).mockResolvedValue(mockMemories)

      const result = await memoryService.searchMemories(mockOrgId, mockAgentId, {
        query: 'test',
        minSimilarity: 0.5
      })

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('mem-1')
    })
  })
})
```

---

## 测试目录结构

```
apps/api/src/__tests__/services/
├── agent.service.test.ts
├── session.service.test.ts
├── message.service.test.ts
├── skill.service.test.ts
├── skill-install.service.test.ts
├── tool.service.test.ts
├── mcp.service.test.ts
├── memory.service.test.ts
└── auth.service.test.ts
```

---

## 修复清单

### Service 测试
- [ ] `session.service.test.ts`
- [ ] `message.service.test.ts`
- [ ] `skill-install.service.test.ts`
- [ ] `tool.service.test.ts`
- [ ] `mcp.service.test.ts`
- [ ] `memory.service.test.ts`

### 补充测试
- [ ] `agent.service.test.ts` - 补充缺失用例
- [ ] `skill.service.test.ts` - 补充缺失用例
- [ ] `auth.service.test.ts` - 补充缺失用例

---

## 完成标准

- [ ] 所有 Service 有测试
- [ ] 测试覆盖率 >= 80%
- [ ] 业务逻辑测试完整
- [ ] 边界条件测试完整
- [ ] CI 集成通过
- [ ] 代码审查通过

---

## 相关文档

- [测试规范](docs/design/TESTING.md)
- [Service 层设计](docs/design/ARCHITECTURE.md)
