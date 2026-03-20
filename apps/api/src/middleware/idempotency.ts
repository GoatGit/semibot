/**
 * 幂等性中间件
 *
 * 基于 X-Request-ID + 内存存储防止重复执行
 * - 首次请求正常执行，结果缓存（5 分钟 TTL）
 * - 重复请求直接返回缓存结果
 * - 未携带 X-Request-ID 的请求直接放行
 */

import type { Request, Response, NextFunction } from 'express'
import { get, setWithExpiry, setNX } from '../lib/mem-store'
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

    try {
      // 检查是否已有缓存结果
      const cached = await get(key)
      if (cached) {
        const cachedResponse: CachedResponse = JSON.parse(cached)
        logger.info('返回幂等性缓存结果', { requestId })
        res.status(cachedResponse.statusCode).json(cachedResponse.body)
        return
      }

      // 尝试获取锁（SET NX）
      const locked = await setNX(
        key,
        JSON.stringify({ statusCode: 202, body: { processing: true } }),
        IDEMPOTENCY_TTL_SECONDS
      )

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
        const cachedData: CachedResponse = { statusCode: res.statusCode, body }
        setWithExpiry(key, JSON.stringify(cachedData), IDEMPOTENCY_TTL_SECONDS).catch((err) => {
          logger.warn('缓存幂等性结果失败', { requestId, error: (err as Error).message })
        })
        return originalJson(body)
      }

      next()
    } catch (error) {
      logger.warn('幂等性检查异常，降级放行', { requestId, error: (error as Error).message })
      next()
    }
  }
}

export default idempotency
