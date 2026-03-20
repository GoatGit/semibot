/**
 * 请求追踪中间件
 *
 * 为每个请求生成或透传 X-Request-ID，注入到 logger 上下文
 */

import crypto from 'crypto'
import type { Request, Response, NextFunction } from 'express'
import { createLogger } from '../lib/logger'

// ═══════════════════════════════════════════════════════════════
// 类型扩展
// ═══════════════════════════════════════════════════════════════

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      traceId?: string
      logger?: ReturnType<typeof createLogger>
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 请求追踪中间件
 *
 * - 从 X-Request-ID header 读取或生成 UUID
 * - 设置到 req.traceId 和响应 header
 * - 创建 childLogger 并注入到 req.logger
 */
export function tracing(req: Request, res: Response, next: NextFunction): void {
  const traceId = (req.headers['x-request-id'] as string) || crypto.randomUUID()

  req.traceId = traceId
  res.setHeader('X-Request-ID', traceId)

  req.logger = createLogger(`req:${traceId.slice(0, 8)}`)

  next()
}
