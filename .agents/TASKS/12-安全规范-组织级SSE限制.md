# 任务：添加组织级SSE连接限制

**优先级**: 🟡 P1 - 高优先级
**类型**: 安全规范
**预估工时**: 1-2 小时
**影响范围**: 1 个文件

---

## 问题描述

当前只有用户级 SSE 连接限制（5个连接/用户），缺少组织级限制。单个组织可能占用过多服务器资源。

---

## 规范要求

根据 `.claude/rules/security.md`:

```typescript
// 需要同时限制
const MAX_SSE_CONNECTIONS_PER_USER = 5
const MAX_SSE_CONNECTIONS_PER_ORG = 50  // ❌ 缺失
```

---

## 当前实现

**文件**: `apps/api/src/services/chat.service.ts:70-78`

```typescript
// ✅ 已有用户级限制
const userConnections = Array.from(sseConnections.values())
  .filter((conn) => conn.userId === userId).length

if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
  console.warn(`[Chat] 用户连接数已达上限 (用户: ${userId}, 当前: ${userConnections}, 限制: ${MAX_SSE_CONNECTIONS_PER_USER})`)
  throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
}

// ❌ 缺少组织级限制
```

---

## 修复方案

### 1. 添加常量定义

**文件**: `packages/shared-config/src/index.ts`

```typescript
// 已有
export const MAX_SSE_CONNECTIONS_PER_USER = 5

// ✅ 添加
export const MAX_SSE_CONNECTIONS_PER_ORG = 50
```

### 2. 修改 SSEConnection 类型

**文件**: `apps/api/src/services/chat.service.ts`

```typescript
interface SSEConnection {
  id: string
  res: Response
  sessionId: string
  userId: string
  orgId: string  // ✅ 添加 orgId
  createdAt: Date
}
```

### 3. 创建连接时传入 orgId

```typescript
export function createSSEConnection(
  res: Response,
  sessionId: string,
  userId: string,
  orgId: string  // ✅ 添加参数
): SSEConnection {
  // 1. 检查用户连接数
  const userConnections = Array.from(sseConnections.values())
    .filter((conn) => conn.userId === userId).length

  if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
    logger.warn('[Chat] 用户连接数已达上限', {
      userId,
      current: userConnections,
      limit: MAX_SSE_CONNECTIONS_PER_USER
    })
    throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
  }

  // ✅ 2. 检查组织连接数
  const orgConnections = Array.from(sseConnections.values())
    .filter((conn) => conn.orgId === orgId).length

  if (orgConnections >= MAX_SSE_CONNECTIONS_PER_ORG) {
    logger.warn('[Chat] 组织连接数已达上限', {
      orgId,
      current: orgConnections,
      limit: MAX_SSE_CONNECTIONS_PER_ORG
    })
    throw createError(SSE_CONNECTION_LIMIT, '组织连接数已达上限，请稍后重试')
  }

  // 3. 创建连接
  const connectionId = generateId()
  const connection: SSEConnection = {
    id: connectionId,
    res,
    sessionId,
    userId,
    orgId,  // ✅ 保存 orgId
    createdAt: new Date()
  }

  sseConnections.set(connectionId, connection)

  logger.info('[Chat] SSE 连接已创建', {
    connectionId,
    sessionId,
    userId,
    orgId,
    userConnections: userConnections + 1,
    orgConnections: orgConnections + 1
  })

  // 4. 设置清理逻辑
  res.on('close', () => {
    closeSSEConnection(connection.id)
  })

  return connection
}
```

### 4. 更新调用处

**文件**: `apps/api/src/services/chat.service.ts`

```typescript
export async function handleChat(
  orgId: string,
  userId: string,
  sessionId: string,
  input: ChatInput,
  res: Response
): Promise<void> {
  // ✅ 传入 orgId
  const connection = createSSEConnection(res, sessionId, userId, orgId)

  // ... 其余逻辑
}
```

---

## 完整修复代码

```typescript
// apps/api/src/services/chat.service.ts

import { MAX_SSE_CONNECTIONS_PER_USER, MAX_SSE_CONNECTIONS_PER_ORG } from '@semibot/shared-config'
import { createLogger } from '../lib/logger'

const logger = createLogger('chat')

interface SSEConnection {
  id: string
  res: Response
  sessionId: string
  userId: string
  orgId: string
  createdAt: Date
}

const sseConnections = new Map<string, SSEConnection>()

export function createSSEConnection(
  res: Response,
  sessionId: string,
  userId: string,
  orgId: string
): SSEConnection {
  // 1. 检查用户连接数
  const userConnections = Array.from(sseConnections.values())
    .filter((conn) => conn.userId === userId).length

  if (userConnections >= MAX_SSE_CONNECTIONS_PER_USER) {
    logger.warn('[Chat] 用户连接数已达上限', {
      userId,
      current: userConnections,
      limit: MAX_SSE_CONNECTIONS_PER_USER
    })
    throw createError(SSE_CONNECTION_LIMIT, 'SSE 连接数已达上限，请关闭其他连接后重试')
  }

  // 2. 检查组织连接数
  const orgConnections = Array.from(sseConnections.values())
    .filter((conn) => conn.orgId === orgId).length

  if (orgConnections >= MAX_SSE_CONNECTIONS_PER_ORG) {
    logger.warn('[Chat] 组织连接数已达上限', {
      orgId,
      current: orgConnections,
      limit: MAX_SSE_CONNECTIONS_PER_ORG
    })
    throw createError(SSE_CONNECTION_LIMIT, '组织连接数已达上限，请稍后重试')
  }

  // 3. 创建连接
  const connectionId = generateId()
  const connection: SSEConnection = {
    id: connectionId,
    res,
    sessionId,
    userId,
    orgId,
    createdAt: new Date()
  }

  sseConnections.set(connectionId, connection)

  logger.info('[Chat] SSE 连接已创建', {
    connectionId,
    sessionId,
    userId,
    orgId,
    userConnections: userConnections + 1,
    orgConnections: orgConnections + 1,
    totalConnections: sseConnections.size
  })

  // 4. 设置清理逻辑
  res.on('close', () => {
    closeSSEConnection(connection.id)
  })

  return connection
}

export function closeSSEConnection(connectionId: string): void {
  const connection = sseConnections.get(connectionId)
  if (!connection) {
    return
  }

  sseConnections.delete(connectionId)

  logger.info('[Chat] SSE 连接已关闭', {
    connectionId,
    sessionId: connection.sessionId,
    userId: connection.userId,
    orgId: connection.orgId,
    duration: Date.now() - connection.createdAt.getTime(),
    remainingConnections: sseConnections.size
  })
}

// 监控函数
export function getConnectionStats(): {
  total: number
  byUser: Map<string, number>
  byOrg: Map<string, number>
} {
  const byUser = new Map<string, number>()
  const byOrg = new Map<string, number>()

  for (const conn of sseConnections.values()) {
    byUser.set(conn.userId, (byUser.get(conn.userId) || 0) + 1)
    byOrg.set(conn.orgId, (byOrg.get(conn.orgId) || 0) + 1)
  }

  return {
    total: sseConnections.size,
    byUser,
    byOrg
  }
}
```

---

## 测试验证

### 1. 单元测试
```typescript
describe('SSE 组织级连接限制', () => {
  it('组织连接数达到上限时应该拒绝新连接', async () => {
    const orgId = 'org-1'

    // 创建 50 个连接（达到上限）
    const connections = []
    for (let i = 0; i < MAX_SSE_CONNECTIONS_PER_ORG; i++) {
      const conn = createSSEConnection(
        mockResponse(),
        `session-${i}`,
        `user-${i}`,
        orgId
      )
      connections.push(conn)
    }

    // 第 51 个连接应该被拒绝
    expect(() => {
      createSSEConnection(
        mockResponse(),
        'session-51',
        'user-51',
        orgId
      )
    }).toThrow('组织连接数已达上限')
  })

  it('不同组织的连接应该独立计数', async () => {
    const orgA = 'org-a'
    const orgB = 'org-b'

    // 组织 A 创建 50 个连接
    for (let i = 0; i < MAX_SSE_CONNECTIONS_PER_ORG; i++) {
      createSSEConnection(
        mockResponse(),
        `session-a-${i}`,
        `user-a-${i}`,
        orgA
      )
    }

    // 组织 B 应该仍然可以创建连接
    expect(() => {
      createSSEConnection(
        mockResponse(),
        'session-b-1',
        'user-b-1',
        orgB
      )
    }).not.toThrow()
  })

  it('关闭连接后应该可以创建新连接', async () => {
    const orgId = 'org-1'

    // 创建 50 个连接
    const connections = []
    for (let i = 0; i < MAX_SSE_CONNECTIONS_PER_ORG; i++) {
      const conn = createSSEConnection(
        mockResponse(),
        `session-${i}`,
        `user-${i}`,
        orgId
      )
      connections.push(conn)
    }

    // 关闭一个连接
    closeSSEConnection(connections[0].id)

    // 应该可以创建新连接
    expect(() => {
      createSSEConnection(
        mockResponse(),
        'session-new',
        'user-new',
        orgId
      )
    }).not.toThrow()
  })
})
```

### 2. 监控测试
```typescript
describe('连接统计', () => {
  it('应该正确统计各组织的连接数', () => {
    createSSEConnection(mockResponse(), 's1', 'u1', 'org-a')
    createSSEConnection(mockResponse(), 's2', 'u2', 'org-a')
    createSSEConnection(mockResponse(), 's3', 'u3', 'org-b')

    const stats = getConnectionStats()

    expect(stats.total).toBe(3)
    expect(stats.byOrg.get('org-a')).toBe(2)
    expect(stats.byOrg.get('org-b')).toBe(1)
  })
})
```

---

## 修复清单

- [ ] 添加 `MAX_SSE_CONNECTIONS_PER_ORG` 常量
- [ ] 修改 `SSEConnection` 接口添加 `orgId`
- [ ] 修改 `createSSEConnection` 添加组织级检查
- [ ] 更新所有调用处传入 `orgId`
- [ ] 添加连接统计函数
- [ ] 添加单元测试
- [ ] 添加监控日志
- [ ] 代码审查

---

## 监控和告警

### 1. 添加监控端点
```typescript
// apps/api/src/routes/v1/monitoring.ts

router.get('/sse/stats', authenticate, requirePermission('monitoring:read'), (req, res) => {
  const stats = getConnectionStats()

  res.json({
    success: true,
    data: {
      total: stats.total,
      byUser: Array.from(stats.byUser.entries()).map(([userId, count]) => ({
        userId,
        count
      })),
      byOrg: Array.from(stats.byOrg.entries()).map(([orgId, count]) => ({
        orgId,
        count,
        percentage: (count / MAX_SSE_CONNECTIONS_PER_ORG) * 100
      }))
    }
  })
})
```

### 2. 添加告警
```typescript
// 定期检查连接数
setInterval(() => {
  const stats = getConnectionStats()

  for (const [orgId, count] of stats.byOrg.entries()) {
    const percentage = (count / MAX_SSE_CONNECTIONS_PER_ORG) * 100

    if (percentage >= 80) {
      logger.warn('[Chat] 组织 SSE 连接数接近上限', {
        orgId,
        current: count,
        limit: MAX_SSE_CONNECTIONS_PER_ORG,
        percentage: percentage.toFixed(2)
      })
    }
  }
}, 60000)  // 每分钟检查一次
```

---

## 完成标准

- [ ] 组织级连接限制已实现
- [ ] 用户级和组织级限制同时生效
- [ ] 日志记录完整
- [ ] 单元测试通过
- [ ] 监控端点已添加
- [ ] 代码审查通过

---

## 相关文档

- [安全规范 - SSE 连接限制](.claude/rules/security.md#sse-连接限制)
- [常量配置](packages/shared-config/src/index.ts)
