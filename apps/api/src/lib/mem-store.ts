/**
 * 内存 KV 存储（替代 Redis）
 *
 * 单用户本地模式下使用内存实现，支持 TTL、Pub/Sub 和 Stream 队列。
 * 接口与原 redis.ts 保持一致，调用方无需修改。
 */

import { EventEmitter } from 'events'
import { createLogger } from './logger'

const logger = createLogger('mem-store')

// ─── TTL KV Store ─────────────────────────────────────────────────────────────

interface KVEntry {
  value: string
  expiresAt: number | null // ms timestamp, null = no expiry
}

const kvStore = new Map<string, KVEntry>()

function isExpired(entry: KVEntry): boolean {
  return entry.expiresAt !== null && Date.now() > entry.expiresAt
}

// 定期清理过期 key（每 60s）
const kvCleanupTimer = setInterval(() => {
  for (const [key, entry] of kvStore) {
    if (isExpired(entry)) kvStore.delete(key)
  }
}, 60_000)
if (typeof kvCleanupTimer.unref === 'function') {
  kvCleanupTimer.unref()
}

export async function setWithExpiry(key: string, value: string, ttlSeconds: number): Promise<void> {
  kvStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}

export async function get(key: string): Promise<string | null> {
  const entry = kvStore.get(key)
  if (!entry || isExpired(entry)) {
    if (entry) kvStore.delete(key)
    return null
  }
  return entry.value
}

export async function del(key: string): Promise<number> {
  return kvStore.delete(key) ? 1 : 0
}

export async function exists(key: string): Promise<boolean> {
  const entry = kvStore.get(key)
  if (!entry || isExpired(entry)) {
    if (entry) kvStore.delete(key)
    return false
  }
  return true
}

/**
 * SET NX EX — 原子性设置（仅当 key 不存在时）
 * 返回 'OK' 表示成功，null 表示 key 已存在
 */
export async function setNX(key: string, value: string, ttlSeconds: number): Promise<'OK' | null> {
  const existing = kvStore.get(key)
  if (existing && !isExpired(existing)) return null
  kvStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  return 'OK'
}

// ─── Pub/Sub ──────────────────────────────────────────────────────────────────

const pubSubEmitter = new EventEmitter()
pubSubEmitter.setMaxListeners(100)

export async function publish(channel: string, message: string): Promise<number> {
  const listenerCount = pubSubEmitter.listenerCount(channel)
  pubSubEmitter.emit(channel, message)
  return listenerCount
}

export function subscribe(channel: string, handler: (message: string) => void): () => void {
  pubSubEmitter.on(channel, handler)
  return () => pubSubEmitter.off(channel, handler)
}

// ─── Stream (内存队列) ────────────────────────────────────────────────────────

interface StreamMessage {
  id: string
  fields: Record<string, string>
  acked: boolean
}

const streams = new Map<string, StreamMessage[]>()
// 每个 stream 的 pending 消息（已读未 ack）
const pendingMessages = new Map<string, Map<string, StreamMessage>>()
// 等待消息的 resolve 回调
const streamWaiters = new Map<string, Array<() => void>>()

let streamSeq = 0

function nextStreamId(): string {
  return `${Date.now()}-${++streamSeq}`
}

export async function xadd(stream: string, fields: Record<string, string>): Promise<string> {
  if (!streams.has(stream)) streams.set(stream, [])
  const id = nextStreamId()
  streams.get(stream)!.push({ id, fields, acked: false })
  // 通知等待者
  const waiters = streamWaiters.get(stream)
  if (waiters && waiters.length > 0) {
    const resolve = waiters.shift()!
    resolve()
  }
  return id
}

export async function createConsumerGroup(stream: string, _group: string): Promise<void> {
  if (!streams.has(stream)) streams.set(stream, [])
  if (!pendingMessages.has(stream)) pendingMessages.set(stream, new Map())
  logger.debug('消费者组已就绪（内存模式）', { stream })
}

export async function xreadgroup(
  _group: string,
  _consumer: string,
  stream: string,
  count: number = 1,
  blockMs: number = 5000
): Promise<Array<{ id: string; fields: Record<string, string> }> | null> {
  const messages = streams.get(stream) ?? []
  const pending = pendingMessages.get(stream) ?? new Map()

  // 找到未 ack 且未 pending 的消息
  const available = messages.filter((m) => !m.acked && !pending.has(m.id))

  if (available.length === 0 && blockMs > 0) {
    // 等待新消息
    await new Promise<void>((resolve) => {
      if (!streamWaiters.has(stream)) streamWaiters.set(stream, [])
      const timer = setTimeout(resolve, blockMs)
      streamWaiters.get(stream)!.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    // 重新检查
    const msgs = streams.get(stream) ?? []
    const pend = pendingMessages.get(stream) ?? new Map()
    const avail = msgs.filter((m) => !m.acked && !pend.has(m.id))
    if (avail.length === 0) return null
    const batch = avail.slice(0, count)
    for (const m of batch) pend.set(m.id, m)
    return batch.map(({ id, fields }) => ({ id, fields }))
  }

  if (available.length === 0) return null

  const batch = available.slice(0, count)
  for (const m of batch) pending.set(m.id, m)
  return batch.map(({ id, fields }) => ({ id, fields }))
}

export async function xack(stream: string, _group: string, messageId: string): Promise<number> {
  const pending = pendingMessages.get(stream)
  if (!pending) return 0
  const msg = pending.get(messageId)
  if (!msg) return 0
  msg.acked = true
  pending.delete(messageId)
  return 1
}

export async function xlen(stream: string): Promise<number> {
  return (streams.get(stream) ?? []).filter((m) => !m.acked).length
}

// ─── 连接状态（兼容接口）────────────────────────────────────────────────────

export function isRedisConnected(): boolean {
  return false // 内存模式，不需要 Redis
}

export async function connectRedis(): Promise<boolean> {
  return true
}

export async function disconnectRedis(): Promise<void> {
  // no-op
}

export async function pingRedis(): Promise<boolean> {
  return true
}

// getRedisClient 不再暴露真实 Redis 客户端
// 保留此函数签名以兼容 idempotency.ts 等调用方
export function getRedisClient(): never {
  throw new Error('[mem-store] getRedisClient() 不可用，请使用 mem-store 提供的函数')
}

export default {
  setWithExpiry,
  get,
  del,
  exists,
  setNX,
  publish,
  subscribe,
  xadd,
  createConsumerGroup,
  xreadgroup,
  xack,
  xlen,
  isRedisConnected,
  connectRedis,
  disconnectRedis,
  pingRedis,
  getRedisClient,
}
