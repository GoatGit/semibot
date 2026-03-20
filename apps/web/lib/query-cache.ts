/**
 * 轻量内存缓存，用于跨组件共享静态数据（LLM 模型列表、MCP 服务器等）。
 *
 * 特性：
 * - TTL 过期自动失效
 * - 请求去重：同一 key 并发调用只发一次请求，其余等待同一个 Promise
 * - 无外部依赖
 */

interface CacheEntry<T> {
  data: T
  expiresAt: number
}

const cache = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/**
 * 带缓存的数据获取。
 *
 * @param key    缓存 key
 * @param fetcher 实际请求函数
 * @param ttlMs  缓存有效期（毫秒），默认 60 秒
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 60_000
): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key) as CacheEntry<T> | undefined
  if (hit && hit.expiresAt > now) {
    return hit.data
  }

  // 请求去重：已有 inflight 请求则复用
  const existing = inflight.get(key) as Promise<T> | undefined
  if (existing) return existing

  const promise = fetcher().then((data) => {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs })
    inflight.delete(key)
    return data
  }).catch((err) => {
    inflight.delete(key)
    throw err
  })

  inflight.set(key, promise)
  return promise
}

/** 手动使某个 key 的缓存失效（写操作后调用） */
export function invalidateCache(key: string): void {
  cache.delete(key)
  inflight.delete(key)
}

/** 使所有以 prefix 开头的 key 失效 */
export function invalidateCacheByPrefix(prefix: string): void {
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of Array.from(inflight.keys())) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
}
