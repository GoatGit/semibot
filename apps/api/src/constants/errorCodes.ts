/**
 * API 错误码定义
 *
 * 格式: CATEGORY_ERROR_NAME
 * 类别:
 *   - AUTH: 认证授权
 *   - VALIDATION: 数据校验
 *   - RESOURCE: 资源操作
 *   - RATE_LIMIT: 限流
 *   - INTERNAL: 内部错误
 *   - EXTERNAL: 外部服务错误
 */

// ═══════════════════════════════════════════════════════════════
// 认证授权错误
// ═══════════════════════════════════════════════════════════════

export const AUTH_TOKEN_MISSING = 'AUTH_TOKEN_MISSING'
export const AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID'
export const AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED'
export const AUTH_API_KEY_INVALID = 'AUTH_API_KEY_INVALID'
export const AUTH_API_KEY_REVOKED = 'AUTH_API_KEY_REVOKED'
export const AUTH_API_KEY_EXPIRED = 'AUTH_API_KEY_EXPIRED'
export const AUTH_PERMISSION_DENIED = 'AUTH_PERMISSION_DENIED'
export const AUTH_ORG_ACCESS_DENIED = 'AUTH_ORG_ACCESS_DENIED'
export const AUTH_USER_NOT_FOUND = 'AUTH_USER_NOT_FOUND'
export const AUTH_INVALID_PASSWORD = 'AUTH_INVALID_PASSWORD'
export const AUTH_EMAIL_EXISTS = 'AUTH_EMAIL_EXISTS'
export const AUTH_REFRESH_TOKEN_INVALID = 'AUTH_REFRESH_TOKEN_INVALID'
export const AUTH_REFRESH_TOKEN_EXPIRED = 'AUTH_REFRESH_TOKEN_EXPIRED'
export const AUTH_RESET_TOKEN_INVALID = 'AUTH_RESET_TOKEN_INVALID'
export const AUTH_RESET_TOKEN_EXPIRED = 'AUTH_RESET_TOKEN_EXPIRED'
export const AUTH_ORG_NOT_FOUND = 'AUTH_ORG_NOT_FOUND'
export const AUTH_USER_INACTIVE = 'AUTH_USER_INACTIVE'

// ═══════════════════════════════════════════════════════════════
// 数据校验错误
// ═══════════════════════════════════════════════════════════════

export const VALIDATION_FAILED = 'VALIDATION_FAILED'
export const VALIDATION_REQUIRED_FIELD = 'VALIDATION_REQUIRED_FIELD'
export const VALIDATION_INVALID_FORMAT = 'VALIDATION_INVALID_FORMAT'
export const VALIDATION_OUT_OF_RANGE = 'VALIDATION_OUT_OF_RANGE'
export const VALIDATION_MESSAGE_TOO_LONG = 'VALIDATION_MESSAGE_TOO_LONG'

// ═══════════════════════════════════════════════════════════════
// 资源操作错误
// ═══════════════════════════════════════════════════════════════

export const RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND'
export const RESOURCE_ALREADY_EXISTS = 'RESOURCE_ALREADY_EXISTS'
export const RESOURCE_CONFLICT = 'RESOURCE_CONFLICT'
export const RESOURCE_DELETED = 'RESOURCE_DELETED'

// Agent 相关
export const AGENT_NOT_FOUND = 'AGENT_NOT_FOUND'
export const AGENT_INACTIVE = 'AGENT_INACTIVE'
export const AGENT_LIMIT_EXCEEDED = 'AGENT_LIMIT_EXCEEDED'

// Skill 相关
export const SKILL_NOT_FOUND = 'SKILL_NOT_FOUND'
export const SKILL_LIMIT_EXCEEDED = 'SKILL_LIMIT_EXCEEDED'
export const SKILL_BUILTIN_READONLY = 'SKILL_BUILTIN_READONLY'

// Tool 相关
export const TOOL_NOT_FOUND = 'TOOL_NOT_FOUND'
export const TOOL_LIMIT_EXCEEDED = 'TOOL_LIMIT_EXCEEDED'
export const TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED'

// MCP 相关
export const MCP_SERVER_NOT_FOUND = 'MCP_SERVER_NOT_FOUND'
export const MCP_SERVER_LIMIT_EXCEEDED = 'MCP_SERVER_LIMIT_EXCEEDED'
export const MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED'
export const MCP_TOOL_CALL_FAILED = 'MCP_TOOL_CALL_FAILED'

// Session 相关
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'
export const SESSION_ALREADY_COMPLETED = 'SESSION_ALREADY_COMPLETED'
export const SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED'

// Message 相关
export const MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND'
export const MESSAGE_LIMIT_EXCEEDED = 'MESSAGE_LIMIT_EXCEEDED'

// ═══════════════════════════════════════════════════════════════
// 限流错误
// ═══════════════════════════════════════════════════════════════

export const RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED'
export const RATE_LIMIT_USER = 'RATE_LIMIT_USER'
export const RATE_LIMIT_ORG = 'RATE_LIMIT_ORG'
export const QUOTA_EXCEEDED = 'QUOTA_EXCEEDED'
export const TOKEN_LIMIT_EXCEEDED = 'TOKEN_LIMIT_EXCEEDED'

// ═══════════════════════════════════════════════════════════════
// 内部错误
// ═══════════════════════════════════════════════════════════════

export const INTERNAL_ERROR = 'INTERNAL_ERROR'
export const DATABASE_ERROR = 'DATABASE_ERROR'
export const CACHE_ERROR = 'CACHE_ERROR'
export const QUEUE_ERROR = 'QUEUE_ERROR'

// ═══════════════════════════════════════════════════════════════
// 外部服务错误
// ═══════════════════════════════════════════════════════════════

export const EXTERNAL_LLM_ERROR = 'EXTERNAL_LLM_ERROR'
export const EXTERNAL_LLM_TIMEOUT = 'EXTERNAL_LLM_TIMEOUT'
export const LLM_UNAVAILABLE = 'LLM_UNAVAILABLE'
export const EXTERNAL_TOOL_ERROR = 'EXTERNAL_TOOL_ERROR'
export const EXTERNAL_TOOL_TIMEOUT = 'EXTERNAL_TOOL_TIMEOUT'
export const EXTERNAL_SERVICE_UNAVAILABLE = 'EXTERNAL_SERVICE_UNAVAILABLE'

// ═══════════════════════════════════════════════════════════════
// SSE 错误
// ═══════════════════════════════════════════════════════════════

export const SSE_CONNECTION_FAILED = 'SSE_CONNECTION_FAILED'
export const SSE_CONNECTION_LIMIT = 'SSE_CONNECTION_LIMIT'
export const SSE_STREAM_ERROR = 'SSE_STREAM_ERROR'

// ═══════════════════════════════════════════════════════════════
// 错误码到 HTTP 状态码映射
// ═══════════════════════════════════════════════════════════════

export const ERROR_HTTP_STATUS: Record<string, number> = {
  // 认证错误 -> 401/403
  [AUTH_TOKEN_MISSING]: 401,
  [AUTH_TOKEN_INVALID]: 401,
  [AUTH_TOKEN_EXPIRED]: 401,
  [AUTH_API_KEY_INVALID]: 401,
  [AUTH_API_KEY_REVOKED]: 401,
  [AUTH_API_KEY_EXPIRED]: 401,
  [AUTH_PERMISSION_DENIED]: 403,
  [AUTH_ORG_ACCESS_DENIED]: 403,
  [AUTH_USER_NOT_FOUND]: 404,
  [AUTH_INVALID_PASSWORD]: 401,
  [AUTH_EMAIL_EXISTS]: 409,
  [AUTH_REFRESH_TOKEN_INVALID]: 401,
  [AUTH_REFRESH_TOKEN_EXPIRED]: 401,
  [AUTH_RESET_TOKEN_INVALID]: 401,
  [AUTH_RESET_TOKEN_EXPIRED]: 401,
  [AUTH_ORG_NOT_FOUND]: 404,
  [AUTH_USER_INACTIVE]: 403,

  // 校验错误 -> 400
  [VALIDATION_FAILED]: 400,
  [VALIDATION_REQUIRED_FIELD]: 400,
  [VALIDATION_INVALID_FORMAT]: 400,
  [VALIDATION_OUT_OF_RANGE]: 400,
  [VALIDATION_MESSAGE_TOO_LONG]: 400,

  // 资源错误 -> 404/409
  [RESOURCE_NOT_FOUND]: 404,
  [RESOURCE_ALREADY_EXISTS]: 409,
  [RESOURCE_CONFLICT]: 409,
  [RESOURCE_DELETED]: 410,
  [AGENT_NOT_FOUND]: 404,
  [AGENT_INACTIVE]: 400,
  [AGENT_LIMIT_EXCEEDED]: 400,
  [SKILL_NOT_FOUND]: 404,
  [SKILL_LIMIT_EXCEEDED]: 400,
  [SKILL_BUILTIN_READONLY]: 400,
  [TOOL_NOT_FOUND]: 404,
  [TOOL_LIMIT_EXCEEDED]: 400,
  [TOOL_EXECUTION_FAILED]: 500,
  [MCP_SERVER_NOT_FOUND]: 404,
  [MCP_SERVER_LIMIT_EXCEEDED]: 400,
  [MCP_CONNECTION_FAILED]: 502,
  [MCP_TOOL_CALL_FAILED]: 502,
  [SESSION_NOT_FOUND]: 404,
  [SESSION_ALREADY_COMPLETED]: 400,
  [SESSION_LIMIT_EXCEEDED]: 400,
  [MESSAGE_NOT_FOUND]: 404,
  [MESSAGE_LIMIT_EXCEEDED]: 400,

  // 限流错误 -> 429
  [RATE_LIMIT_EXCEEDED]: 429,
  [RATE_LIMIT_USER]: 429,
  [RATE_LIMIT_ORG]: 429,
  [QUOTA_EXCEEDED]: 429,
  [TOKEN_LIMIT_EXCEEDED]: 429,

  // 内部错误 -> 500
  [INTERNAL_ERROR]: 500,
  [DATABASE_ERROR]: 500,
  [CACHE_ERROR]: 500,
  [QUEUE_ERROR]: 500,

  // 外部服务错误 -> 502/504
  [EXTERNAL_LLM_ERROR]: 502,
  [EXTERNAL_LLM_TIMEOUT]: 504,
  [LLM_UNAVAILABLE]: 503,
  [EXTERNAL_TOOL_ERROR]: 502,
  [EXTERNAL_TOOL_TIMEOUT]: 504,
  [EXTERNAL_SERVICE_UNAVAILABLE]: 503,

  // SSE 错误
  [SSE_CONNECTION_FAILED]: 500,
  [SSE_CONNECTION_LIMIT]: 429,
  [SSE_STREAM_ERROR]: 500,
}

// ═══════════════════════════════════════════════════════════════
// 错误码到消息映射
// ═══════════════════════════════════════════════════════════════

export const ERROR_MESSAGES: Record<string, string> = {
  // 认证错误
  [AUTH_TOKEN_MISSING]: '缺少认证令牌',
  [AUTH_TOKEN_INVALID]: '认证令牌无效',
  [AUTH_TOKEN_EXPIRED]: '认证令牌已过期',
  [AUTH_API_KEY_INVALID]: 'API Key 无效',
  [AUTH_API_KEY_REVOKED]: 'API Key 已被吊销',
  [AUTH_API_KEY_EXPIRED]: 'API Key 已过期',
  [AUTH_PERMISSION_DENIED]: '权限不足',
  [AUTH_ORG_ACCESS_DENIED]: '无权访问该组织资源',
  [AUTH_USER_NOT_FOUND]: '用户不存在',
  [AUTH_INVALID_PASSWORD]: '密码错误',
  [AUTH_EMAIL_EXISTS]: '邮箱已被注册',
  [AUTH_REFRESH_TOKEN_INVALID]: '刷新令牌无效',
  [AUTH_REFRESH_TOKEN_EXPIRED]: '刷新令牌已过期',
  [AUTH_RESET_TOKEN_INVALID]: '重置令牌无效',
  [AUTH_RESET_TOKEN_EXPIRED]: '重置令牌已过期',
  [AUTH_ORG_NOT_FOUND]: '组织不存在',
  [AUTH_USER_INACTIVE]: '用户已被禁用',

  // 校验错误
  [VALIDATION_FAILED]: '数据校验失败',
  [VALIDATION_REQUIRED_FIELD]: '缺少必填字段',
  [VALIDATION_INVALID_FORMAT]: '数据格式无效',
  [VALIDATION_OUT_OF_RANGE]: '数值超出范围',
  [VALIDATION_MESSAGE_TOO_LONG]: '消息内容过长',

  // 资源错误
  [RESOURCE_NOT_FOUND]: '资源不存在',
  [RESOURCE_ALREADY_EXISTS]: '资源已存在',
  [RESOURCE_CONFLICT]: '资源冲突',
  [RESOURCE_DELETED]: '资源已删除',
  [AGENT_NOT_FOUND]: 'Agent 不存在',
  [AGENT_INACTIVE]: 'Agent 未启用',
  [AGENT_LIMIT_EXCEEDED]: 'Agent 数量已达上限',
  [SKILL_NOT_FOUND]: 'Skill 不存在',
  [SKILL_LIMIT_EXCEEDED]: 'Skill 数量已达上限',
  [SKILL_BUILTIN_READONLY]: '内置 Skill 不可修改',
  [TOOL_NOT_FOUND]: 'Tool 不存在',
  [TOOL_LIMIT_EXCEEDED]: 'Tool 数量已达上限',
  [TOOL_EXECUTION_FAILED]: 'Tool 执行失败',
  [MCP_SERVER_NOT_FOUND]: 'MCP Server 不存在',
  [MCP_SERVER_LIMIT_EXCEEDED]: 'MCP Server 数量已达上限',
  [MCP_CONNECTION_FAILED]: 'MCP Server 连接失败',
  [MCP_TOOL_CALL_FAILED]: 'MCP 工具调用失败',
  [SESSION_NOT_FOUND]: '会话不存在',
  [SESSION_ALREADY_COMPLETED]: '会话已结束',
  [SESSION_LIMIT_EXCEEDED]: '会话数量已达上限',
  [MESSAGE_NOT_FOUND]: '消息不存在',
  [MESSAGE_LIMIT_EXCEEDED]: '消息数量已达上限',

  // 限流错误
  [RATE_LIMIT_EXCEEDED]: '请求过于频繁，请稍后重试',
  [RATE_LIMIT_USER]: '用户请求限制已达上限',
  [RATE_LIMIT_ORG]: '组织请求限制已达上限',
  [QUOTA_EXCEEDED]: '配额已用尽',
  [TOKEN_LIMIT_EXCEEDED]: 'Token 使用量已达上限',

  // 内部错误
  [INTERNAL_ERROR]: '服务内部错误',
  [DATABASE_ERROR]: '数据库错误',
  [CACHE_ERROR]: '缓存服务错误',
  [QUEUE_ERROR]: '队列服务错误',

  // 外部服务错误
  [EXTERNAL_LLM_ERROR]: 'LLM 服务调用失败',
  [EXTERNAL_LLM_TIMEOUT]: 'LLM 服务响应超时',
  [LLM_UNAVAILABLE]: '当前没有可用的模型服务',
  [EXTERNAL_TOOL_ERROR]: '工具调用失败',
  [EXTERNAL_TOOL_TIMEOUT]: '工具调用超时',
  [EXTERNAL_SERVICE_UNAVAILABLE]: '外部服务暂不可用',

  // SSE 错误
  [SSE_CONNECTION_FAILED]: 'SSE 连接失败',
  [SSE_CONNECTION_LIMIT]: 'SSE 连接数已达上限',
  [SSE_STREAM_ERROR]: 'SSE 流传输错误',
}
