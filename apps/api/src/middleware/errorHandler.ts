/**
 * 统一错误处理中间件
 */

import type { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import {
  INTERNAL_ERROR,
  VALIDATION_FAILED,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES,
  AUTH_TOKEN_MISSING,
  AUTH_PERMISSION_DENIED,
  RESOURCE_NOT_FOUND,
  AGENT_NOT_FOUND,
  SESSION_NOT_FOUND,
  SKILL_NOT_FOUND,
  TOOL_NOT_FOUND,
  MCP_SERVER_NOT_FOUND,
  RESOURCE_CONFLICT,
  RATE_LIMIT_EXCEEDED,
  getErrorMessage,
} from '../constants/errorCodes'
import { createLogger } from '../lib/logger'

const errorLogger = createLogger('error')

/**
 * 从 Accept-Language header 解析 locale
 */
function parseLocale(req: Request): string {
  const rawAcceptLang = req.headers?.['accept-language']
  const acceptLang = Array.isArray(rawAcceptLang) ? rawAcceptLang.join(',') : (rawAcceptLang ?? '')
  if (acceptLang.includes('en')) return 'en-US'
  return 'zh-CN'
}

// ═══════════════════════════════════════════════════════════════
// 自定义错误类
// ═══════════════════════════════════════════════════════════════

export class AppError extends Error {
  public readonly code: string
  public readonly statusCode: number
  public readonly details?: unknown

  constructor(code: string, message?: string, details?: unknown) {
    super(message ?? ERROR_MESSAGES[code] ?? '未知错误')
    this.code = code
    this.statusCode = ERROR_HTTP_STATUS[code] ?? 500
    this.details = details
    this.name = 'AppError'

    // 捕获堆栈跟踪
    Error.captureStackTrace(this, this.constructor)
  }
}

/**
 * 创建业务错误
 */
export function createError(code: string, message?: string, details?: unknown): AppError {
  return new AppError(code, message, details)
}

// ═══════════════════════════════════════════════════════════════
// 便捷错误创建函数
// ═══════════════════════════════════════════════════════════════

/**
 * 错误便捷函数集合
 */
export const errors = {
  /** 未认证错误 */
  unauthorized: (message?: string) => createError(AUTH_TOKEN_MISSING, message),

  /** 权限不足错误 */
  forbidden: (message?: string) => createError(AUTH_PERMISSION_DENIED, message),

  /** 资源未找到错误 */
  notFound: (resource: 'Agent' | 'Session' | 'Skill' | 'Tool' | 'McpServer' | 'Resource') => {
    const codeMap: Record<string, string> = {
      Agent: AGENT_NOT_FOUND,
      Session: SESSION_NOT_FOUND,
      Skill: SKILL_NOT_FOUND,
      Tool: TOOL_NOT_FOUND,
      McpServer: MCP_SERVER_NOT_FOUND,
      Resource: RESOURCE_NOT_FOUND,
    }
    return createError(codeMap[resource] ?? RESOURCE_NOT_FOUND)
  },

  /** 验证错误 */
  validation: (details?: unknown) => createError(VALIDATION_FAILED, undefined, details),

  /** 版本冲突错误 */
  conflict: (message?: string) => createError(RESOURCE_CONFLICT, message ?? '数据已被其他用户修改，请刷新后重试'),

  /** 限流错误 */
  rateLimit: (message?: string) => createError(RATE_LIMIT_EXCEEDED, message),

  /** 内部错误 */
  internal: (message?: string) => createError(INTERNAL_ERROR, message),
}

// ═══════════════════════════════════════════════════════════════
// 错误格式化
// ═══════════════════════════════════════════════════════════════

interface ErrorResponse {
  success: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

/**
 * 格式化 Zod 验证错误
 */
function formatZodError(error: ZodError, locale?: string): ErrorResponse {
  const details = error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
  }))

  return {
    success: false,
    error: {
      code: VALIDATION_FAILED,
      message: getErrorMessage(VALIDATION_FAILED, locale),
      details,
    },
  }
}

/**
 * 格式化 AppError
 */
function formatAppError(error: AppError, locale?: string): ErrorResponse {
  return {
    success: false,
    error: {
      code: error.code,
      message: error.message !== ERROR_MESSAGES[error.code]
        ? error.message  // 保留自定义消息
        : getErrorMessage(error.code, locale),
      details: error.details,
    },
  }
}

/**
 * 格式化通用错误
 */
function formatGenericError(error: Error, locale?: string): ErrorResponse {
  // 生产环境不暴露内部错误详情
  const isProduction = process.env.NODE_ENV === 'production'

  return {
    success: false,
    error: {
      code: INTERNAL_ERROR,
      message: isProduction ? getErrorMessage(INTERNAL_ERROR, locale) : error.message,
      details: isProduction ? undefined : error.stack,
    },
  }
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

/**
 * 统一错误处理中间件
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const locale = parseLocale(req)

  // 记录错误日志
  errorLogger.error('请求处理错误', error, {
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query,
  })

  // Zod 验证错误
  if (error instanceof ZodError) {
    const response = formatZodError(error, locale)
    res.status(400).json(response)
    return
  }

  // 业务错误
  if (error instanceof AppError) {
    const response = formatAppError(error, locale)
    res.status(error.statusCode).json(response)
    return
  }

  // 其他错误
  const response = formatGenericError(error, locale)
  res.status(500).json(response)
}

/**
 * 404 处理中间件
 */
export function notFoundHandler(req: Request, res: Response): void {
  const locale = parseLocale(req)
  const isEnglish = locale === 'en-US'
  res.status(404).json({
    success: false,
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: isEnglish
        ? `Route not found: ${req.method} ${req.path}`
        : `路由不存在: ${req.method} ${req.path}`,
    },
  })
}

/**
 * 异步处理包装器 - 自动捕获异步错误
 */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: T, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * 请求验证中间件工厂
 */
export function validate<T>(schema: { parse: (data: unknown) => T }, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const data = req[source]
      const validated = schema.parse(data)

      // 将验证后的数据替换原数据
      if (source === 'body') {
        req.body = validated
      } else if (source === 'query') {
        req.query = validated as never
      } else if (source === 'params') {
        req.params = validated as never
      }

      next()
    } catch (error) {
      next(error)
    }
  }
}
