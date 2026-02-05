# PRD: Queue Service 实现

## 概述

`queue.service.ts` 中所有函数都是空壳实现，包含 6 个 TODO 注释，需要完成 Redis Stream 集成。

## 问题描述

```typescript
// 当前状态 - 所有函数都是 stub
async enqueue(queue, task) {
  // TODO: 实现 Redis XADD
  console.log(`[Queue] 任务入队: ${queue}`)
}

async dequeue(queue, consumerGroup) {
  // TODO: 实现 Redis XREADGROUP
  return null
}

async acknowledge(queue, messageId) {
  // TODO: 实现 Redis XACK
}
```

## 目标

1. 实现基于 Redis Stream 的任务队列
2. 支持消费者组和消息确认
3. 实现任务发布/订阅机制

## 技术方案

### 1. Redis 客户端配置

```typescript
// lib/redis.ts
import Redis from 'ioredis'

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
})
```

### 2. Queue Service 实现

```typescript
// services/queue.service.ts
import { redis } from '@/lib/redis'
import { QUEUE_CONFIG } from '@/constants/config'

export class QueueService {
  async enqueue(queue: string, task: QueueTask): Promise<string> {
    const messageId = await redis.xadd(
      queue,
      '*',
      'data', JSON.stringify(task)
    )
    console.log(`[Queue] 任务入队成功: ${queue}, messageId: ${messageId}`)
    return messageId
  }

  async dequeue(
    queue: string,
    consumerGroup: string,
    consumer: string
  ): Promise<QueueTask | null> {
    // 创建消费者组（如果不存在）
    try {
      await redis.xgroup('CREATE', queue, consumerGroup, '0', 'MKSTREAM')
    } catch (e) {
      // 组已存在，忽略
    }

    const messages = await redis.xreadgroup(
      'GROUP', consumerGroup, consumer,
      'COUNT', 1,
      'BLOCK', QUEUE_CONFIG.BLOCK_TIMEOUT,
      'STREAMS', queue, '>'
    )

    if (!messages || messages.length === 0) {
      return null
    }

    const [, entries] = messages[0]
    const [messageId, fields] = entries[0]
    const task = JSON.parse(fields[1]) as QueueTask
    task.messageId = messageId

    return task
  }

  async acknowledge(queue: string, group: string, messageId: string): Promise<void> {
    await redis.xack(queue, group, messageId)
    console.log(`[Queue] 消息确认: ${queue}, messageId: ${messageId}`)
  }

  async publish(channel: string, message: unknown): Promise<void> {
    await redis.publish(channel, JSON.stringify(message))
  }

  async getQueueLength(queue: string): Promise<number> {
    return await redis.xlen(queue)
  }

  async healthCheck(): Promise<boolean> {
    try {
      await redis.ping()
      return true
    } catch {
      return false
    }
  }
}
```

### 3. 配置常量

```typescript
// constants/config.ts
export const QUEUE_CONFIG = {
  /** 阻塞读取超时（毫秒） */
  BLOCK_TIMEOUT: 5000,
  /** 任务队列名称 */
  QUEUES: {
    AGENT_EXECUTION: 'semibot:agent:execution',
    MEMORY_INDEXING: 'semibot:memory:indexing',
    NOTIFICATION: 'semibot:notification',
  },
  /** 消费者组名称 */
  CONSUMER_GROUPS: {
    AGENT_WORKERS: 'agent-workers',
    MEMORY_WORKERS: 'memory-workers',
  },
} as const
```

## 验收标准

- [ ] 所有 6 个 TODO 完成实现
- [ ] Redis 连接健康检查通过
- [ ] 任务入队/出队正常工作
- [ ] 消息确认机制正常
- [ ] 单元测试覆盖率 > 80%

## 优先级

**P1 - 高优先级**

## 相关文件

- `apps/api/src/services/queue.service.ts`
- `apps/api/src/lib/redis.ts` (新建)
- `apps/api/src/constants/config.ts`
