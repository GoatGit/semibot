/**
 * 错误处理工具
 *
 * 提供统一的错误处理、格式化和用户友好消息
 */

// ═══════════════════════════════════════════════════════════════
// 错误消息映射
// ═══════════════════════════════════════════════════════════════

export const ERROR_MESSAGES: Record<string, string> = {
  // 认证错误
  AUTH_UNAUTHORIZED: '请先登录',
  AUTH_TOKEN_EXPIRED: '登录已过期，请重新登录',
  AUTH_INVALID_CREDENTIALS: '邮箱或密码错误',
  AUTH_USER_NOT_FOUND: '用户不存在',
  AUTH_EMAIL_EXISTS: '该邮箱已注册',

  // 验证错误
  VALIDATION_FAILED: '输入数据格式错误',

  // 资源错误
  NOT_FOUND: '请求的资源不存在',
  AGENT_NOT_FOUND: 'Agent 不存在',
  SESSION_NOT_FOUND: '会话不存在',

  // 权限错误
  FORBIDDEN: '没有权限执行此操作',
  PERMISSION_DENIED: '权限不足',

  // 限流错误
  RATE_LIMIT_EXCEEDED: '请求过于频繁，请稍后再试',
  RATE_LIMIT_USER: '您的请求过于频繁，请稍后再试',
  RATE_LIMIT_ORG: '组织请求配额已用尽，请稍后再试',

  // 服务器错误
  INTERNAL_ERROR: '服务器内部错误，请稍后重试',
  SERVICE_UNAVAILABLE: '服务暂时不可用，请稍后重试',

  // 网络错误
  NETWORK_ERROR: '网络连接失败，请检查网络',
  TIMEOUT: '请求超时，请稍后重试',

  // 默认
  UNKNOWN: '发生未知错误，请稍后重试',
}

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ApiError {
  code: string
  message: string
  details?: Array<{ field: string; message: string }>
}

export interface ApiErrorResponse {
  success: false
  error: ApiError
}

// ═══════════════════════════════════════════════════════════════
// 错误处理函数
// ═══════════════════════════════════════════════════════════════

/**
 * 获取用户友好的错误消息
 */
export function getErrorMessage(error: unknown): string {
  // API 错误响应
  if (isApiError(error)) {
    return ERROR_MESSAGES[error.code] || error.message || ERROR_MESSAGES.UNKNOWN
  }

  // 标准 Error 对象
  if (error instanceof Error) {
    // 网络错误
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return ERROR_MESSAGES.NETWORK_ERROR
    }

    // 超时错误
    if (error.name === 'AbortError') {
      return ERROR_MESSAGES.TIMEOUT
    }

    return error.message || ERROR_MESSAGES.UNKNOWN
  }

  // 字符串错误
  if (typeof error === 'string') {
    return error
  }

  return ERROR_MESSAGES.UNKNOWN
}

/**
 * 检查是否为 API 错误
 */
export function isApiError(error: unknown): error is ApiError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as ApiError).code === 'string'
  )
}

/**
 * 检查是否为认证错误 (需要重新登录)
 */
export function isAuthError(error: unknown): boolean {
  if (!isApiError(error)) return false

  const authErrorCodes = [
    'AUTH_UNAUTHORIZED',
    'AUTH_TOKEN_EXPIRED',
    'AUTH_TOKEN_INVALID',
  ]

  return authErrorCodes.includes(error.code)
}

/**
 * 检查是否为限流错误
 */
export function isRateLimitError(error: unknown): boolean {
  if (!isApiError(error)) return false

  return error.code.startsWith('RATE_LIMIT')
}

/**
 * 处理 API 错误响应
 */
export function handleApiError(
  error: unknown,
  options?: {
    onAuthError?: () => void
    onRateLimitError?: (retryAfter?: number) => void
    onError?: (message: string) => void
  }
): string {
  const message = getErrorMessage(error)

  // 认证错误处理
  if (isAuthError(error)) {
    options?.onAuthError?.()
    return message
  }

  // 限流错误处理
  if (isRateLimitError(error) && isApiError(error)) {
    const retryAfter = (error as ApiError & { retryAfter?: number }).retryAfter
    options?.onRateLimitError?.(retryAfter)
    return message
  }

  // 通用错误处理
  options?.onError?.(message)
  return message
}

/**
 * 创建错误处理器 (用于 try-catch)
 */
export function createErrorHandler(options?: {
  onAuthError?: () => void
  onError?: (message: string) => void
  logError?: boolean
}) {
  return (error: unknown): string => {
    if (options?.logError !== false) {
      console.error('[Error Handler]', error)
    }

    const message = handleApiError(error, {
      onAuthError: options?.onAuthError,
      onError: options?.onError,
    })

    return message
  }
}
