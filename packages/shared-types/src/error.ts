/**
 * 跨层统一错误协议
 *
 * API 层和 Runtime 层统一使用此格式，前端只需处理一种错误结构。
 */

// =============================================================================
// UnifiedError 接口
// =============================================================================

/**
 * 跨层统一错误接口
 *
 * 所有层（API、Runtime）的错误响应都遵循此结构。
 */
export interface UnifiedError {
  /** 错误码（如 RESOURCE_NOT_FOUND, VALIDATION_FAILED） */
  code: string
  /** 人类可读的错误消息 */
  message: string
  /** HTTP 状态码 */
  httpStatus: number
  /** 错误详情（可选，如验证错误的字段列表） */
  details?: unknown
  /** 请求追踪 ID（可选，用于全链路追踪） */
  traceId?: string
}

/**
 * 统一错误响应格式
 */
export interface UnifiedErrorResponse {
  success: false
  error: UnifiedError
}
