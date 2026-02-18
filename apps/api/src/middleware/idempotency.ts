/**
 * 幂等性中间件
 *
 * 基于 X-Request-ID + Redis 防止重复执行
 * - 首次请求正常执行，结果缓存到 Redis (5 分钟 TTL)
 * - 重复请求直接返回缓存结果
 * - 未携带 X-Request-ID 的请求直接放行
 * - Redis 不可用时降级为直接放行
 */

import type { Request, Response, NextFunction } from 'express'
import { getRedisClient, isRedisConnected } from '../lib/redis'
import { createLogger } from '../lib/logger'

const logger = createLogger('idempotency')

const IDEMPOTENCY_TTL_SECONDS = 300 // 5 分钟
const IDEMPOTENCY_PREFIX = 'idempotency:'

interface CachedResponse {
  statusCode: number
  body: unknown
}

/**
 * 幂等性中间件
 */
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requestId = req.headers['x-request-id'] as string | undefined

    // 未携带 X-Request-ID，直接放行
    if (!requestId) {
      next()
      return
    }

    const key = `${IDEMPOTENCY_PREFIX}${requestId}`

    // Redis 不可用时降级放行
    if (!isRedisConnected()) {
      logger.warn('Redis 不可用，幂等性检查降级放行', { requestId })
      next()
      return
    }

    try {
      const redis = getRedisClient()

      // 检查是否已有缓存结果
      const cached = await redis.get(key)
      if (cached) {
        const cachedResponse: CachedResponse = JSON.parse(cached)
        logger.info('返回幂等性缓存结果', { requestId })
        res.status(cachedResponse.statusCode).json(cachedResponse.body)
        return
      }

      // 尝试获取锁 (SET NX)
      const locked = await redis.set(key, JSON.stringify({ statusCode: 202, body: { processing: true } }), 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX')

      if (!locked) {
        // 另一个请求正在处理中
        res.status(409).json({
          success: false,
          error: { code: 'REQUEST_IN_PROGRESS', message: '请求正在处理中，请稍后重试' },
        })
        return
      }

      // 拦截 res.json 以缓存响应
      const originalJson = res.json.bind(res)
      res.json = function (body: unknown) {
        // 异步缓存，不阻塞响应
        const cachedData: CachedResponse = {
          statusCode: res.statusCode,
          body,
        }
        redis.set(key, JSON.stringify(cachedData), 'EX', IDEMPOTENCY_TTL_SECONDS).catch((err) => {
          logger.warn('缓存幂等性结果失败', { requestId, error: (err as Error).message })
        })
        return originalJson(body)
      }

      next()
    } catch (error) {
      // Redis 异常时降级放行
      logger.warn('幂等性检查异常，降级放行', { requestId, error: (error as Error).message })
      next()
    }
  }
}

export default idempotency
