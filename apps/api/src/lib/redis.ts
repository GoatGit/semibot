/**
 * Redis 客户端封装
 *
 * 提供 Redis 连接管理和常用操作
 */

import Redis from 'ioredis'
import {
  REDIS_URL,
  REDIS_COMMAND_TIMEOUT_MS,
} from '../constants/config'

// ═══════════════════════════════════════════════════════════════
// Redis 客户端实例
// ═══════════════════════════════════════════════════════════════

let redisClient: Redis | null = null
let isConnected = false

/**
 * 获取 Redis 客户端
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error('[Redis] 重试次数超限，停止重试')
          return null
        }
        const delay = Math.min(times * 200, 2000)
        console.warn(`[Redis] 连接失败，${delay}ms 后重试 (第 ${times} 次)`)
        return delay
      },
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      lazyConnect: true,
    })

    redisClient.on('connect', () => {
      isConnected = true
      console.log('[Redis] 连接成功')
    })

    redisClient.on('error', (error) => {
      console.error('[Redis] 连接错误:', error.message)
      isConnected = false
    })

    redisClient.on('close', () => {
      console.log('[Redis] 连接已关闭')
      isConnected = false
    })
  }

  return redisClient
}

/**
 * 检查 Redis 是否连接
 */
export function isRedisConnected(): boolean {
  return isConnected && redisClient?.status === 'ready'
}

/**
 * 连接 Redis
 */
export async function connectRedis(): Promise<boolean> {
  try {
    const client = getRedisClient()
    await client.connect()
    return true
  } catch (error) {
    console.error('[Redis] 连接失败:', error)
    return false
  }
}

/**
 * 断开 Redis 连接
 */
export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit()
    redisClient = null
    isConnected = false
    console.log('[Redis] 已断开连接')
  }
}

/**
 * Redis 健康检查
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const client = getRedisClient()
    const result = await client.ping()
    return result === 'PONG'
  } catch (error) {
    console.error('[Redis] Ping 失败:', error)
    return false
  }
}

// ═══════════════════════════════════════════════════════════════
// 便捷操作方法
// ═══════════════════════════════════════════════════════════════

/**
 * 设置键值 (带过期时间)
 */
export async function setWithExpiry(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  const client = getRedisClient()
  await client.setex(key, ttlSeconds, value)
}

/**
 * 获取键值
 */
export async function get(key: string): Promise<string | null> {
  const client = getRedisClient()
  return client.get(key)
}

/**
 * 删除键
 */
export async function del(key: string): Promise<number> {
  const client = getRedisClient()
  return client.del(key)
}

/**
 * 检查键是否存在
 */
export async function exists(key: string): Promise<boolean> {
  const client = getRedisClient()
  const result = await client.exists(key)
  return result === 1
}

/**
 * 发布消息到频道
 */
export async function publish(channel: string, message: string): Promise<number> {
  const client = getRedisClient()
  return client.publish(channel, message)
}

// ═══════════════════════════════════════════════════════════════
// Stream 操作 (用于队列)
// ═══════════════════════════════════════════════════════════════

/**
 * 添加消息到 Stream
 */
export async function xadd(
  stream: string,
  fields: Record<string, string>
): Promise<string> {
  const client = getRedisClient()
  const args: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    args.push(key, value)
  }
  const result = await client.xadd(stream, '*', ...args)
  return result ?? ''
}

/**
 * 创建消费者组
 */
export async function createConsumerGroup(
  stream: string,
  group: string
): Promise<void> {
  const client = getRedisClient()
  try {
    await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM')
    console.log(`[Redis] 消费者组已创建: ${group}`)
  } catch (error) {
    // 如果组已存在，忽略错误
    if ((error as Error).message?.includes('BUSYGROUP')) {
      console.log(`[Redis] 消费者组已存在: ${group}`)
    } else {
      throw error
    }
  }
}

/**
 * 从消费者组读取消息
 */
export async function xreadgroup(
  group: string,
  consumer: string,
  stream: string,
  count: number = 1,
  blockMs: number = 5000
): Promise<Array<{ id: string; fields: Record<string, string> }> | null> {
  const client = getRedisClient()

  const result = await client.xreadgroup(
    'GROUP',
    group,
    consumer,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    stream,
    '>'
  )

  if (!result || result.length === 0) {
    return null
  }

  const [, messages] = result[0] as [string, Array<[string, string[]]>]
  return messages.map(([id, fieldsArray]) => {
    const fields: Record<string, string> = {}
    for (let i = 0; i < fieldsArray.length; i += 2) {
      fields[fieldsArray[i]] = fieldsArray[i + 1]
    }
    return { id, fields }
  })
}

/**
 * 确认消息已处理
 */
export async function xack(
  stream: string,
  group: string,
  messageId: string
): Promise<number> {
  const client = getRedisClient()
  return client.xack(stream, group, messageId)
}

/**
 * 获取 Stream 长度
 */
export async function xlen(stream: string): Promise<number> {
  const client = getRedisClient()
  return client.xlen(stream)
}

export default {
  getRedisClient,
  isRedisConnected,
  connectRedis,
  disconnectRedis,
  pingRedis,
  setWithExpiry,
  get,
  del,
  exists,
  publish,
  xadd,
  createConsumerGroup,
  xreadgroup,
  xack,
  xlen,
}
