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
export const AGENT_SYSTEM_READONLY = 'AGENT_SYSTEM_READONLY'

// Skill 相关
export const SKILL_NOT_FOUND = 'SKILL_NOT_FOUND'
export const SKILL_LIMIT_EXCEEDED = 'SKILL_LIMIT_EXCEEDED'
export const SKILL_BUILTIN_READONLY = 'SKILL_BUILTIN_READONLY'
export const SKILL_UPLOAD_TOO_LARGE = 'SKILL_UPLOAD_TOO_LARGE'
export const SKILL_UPLOAD_INVALID_TYPE = 'SKILL_UPLOAD_INVALID_TYPE'
export const SKILL_UPLOAD_EXTRACT_FAILED = 'SKILL_UPLOAD_EXTRACT_FAILED'
export const SKILL_UPLOAD_NO_FILE = 'SKILL_UPLOAD_NO_FILE'

// Tool 相关
export const TOOL_NOT_FOUND = 'TOOL_NOT_FOUND'
export const TOOL_LIMIT_EXCEEDED = 'TOOL_LIMIT_EXCEEDED'
export const TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED'

// MCP 相关
export const MCP_SERVER_NOT_FOUND = 'MCP_SERVER_NOT_FOUND'
export const MCP_SERVER_LIMIT_EXCEEDED = 'MCP_SERVER_LIMIT_EXCEEDED'
export const MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED'
export const MCP_TOOL_CALL_FAILED = 'MCP_TOOL_CALL_FAILED'

// Chat Upload 相关
export const CHAT_UPLOAD_TOO_LARGE = 'CHAT_UPLOAD_TOO_LARGE'
export const CHAT_UPLOAD_INVALID_TYPE = 'CHAT_UPLOAD_INVALID_TYPE'
export const CHAT_UPLOAD_TOO_MANY_FILES = 'CHAT_UPLOAD_TOO_MANY_FILES'
export const CHAT_UPLOAD_NO_FILE = 'CHAT_UPLOAD_NO_FILE'

// Session 相关
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'
export const SESSION_ALREADY_COMPLETED = 'SESSION_ALREADY_COMPLETED'
export const SESSION_LIMIT_EXCEEDED = 'SESSION_LIMIT_EXCEEDED'

// Message 相关
export const MESSAGE_NOT_FOUND = 'MESSAGE_NOT_FOUND'
export const MESSAGE_LIMIT_EXCEEDED = 'MESSAGE_LIMIT_EXCEEDED'

// 进化技能相关
export const EVOLVED_SKILL_NOT_FOUND = 'EVOLVED_SKILL_NOT_FOUND'
export const EVOLVED_SKILL_INVALID_STATUS = 'EVOLVED_SKILL_INVALID_STATUS'
export const EVOLVED_SKILL_REVIEW_FAILED = 'EVOLVED_SKILL_REVIEW_FAILED'

// Webhook 相关
export const WEBHOOK_NOT_FOUND = 'WEBHOOK_NOT_FOUND'
export const WEBHOOK_LIMIT_EXCEEDED = 'WEBHOOK_LIMIT_EXCEEDED'
export const WEBHOOK_DISABLED = 'WEBHOOK_DISABLED'

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
  [AGENT_SYSTEM_READONLY]: 403,
  [SKILL_NOT_FOUND]: 404,
  [SKILL_LIMIT_EXCEEDED]: 400,
  [SKILL_BUILTIN_READONLY]: 400,
  [SKILL_UPLOAD_TOO_LARGE]: 413,
  [SKILL_UPLOAD_INVALID_TYPE]: 400,
  [SKILL_UPLOAD_EXTRACT_FAILED]: 400,
  [SKILL_UPLOAD_NO_FILE]: 400,
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
  [EVOLVED_SKILL_NOT_FOUND]: 404,
  [EVOLVED_SKILL_INVALID_STATUS]: 400,
  [EVOLVED_SKILL_REVIEW_FAILED]: 400,
  [WEBHOOK_NOT_FOUND]: 404,
  [WEBHOOK_LIMIT_EXCEEDED]: 400,
  [WEBHOOK_DISABLED]: 400,

  // Chat Upload 错误
  [CHAT_UPLOAD_TOO_LARGE]: 413,
  [CHAT_UPLOAD_INVALID_TYPE]: 400,
  [CHAT_UPLOAD_TOO_MANY_FILES]: 400,
  [CHAT_UPLOAD_NO_FILE]: 400,

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
  [AGENT_SYSTEM_READONLY]: '系统 Agent 不可修改或删除',
  [SKILL_NOT_FOUND]: 'Skill 不存在',
  [SKILL_LIMIT_EXCEEDED]: 'Skill 数量已达上限',
  [SKILL_BUILTIN_READONLY]: '内置 Skill 不可修改',
  [SKILL_UPLOAD_TOO_LARGE]: '上传文件超过大小限制',
  [SKILL_UPLOAD_INVALID_TYPE]: '不支持的文件类型，仅支持 .zip/.tar.gz/.tgz',
  [SKILL_UPLOAD_EXTRACT_FAILED]: '解压文件失败',
  [SKILL_UPLOAD_NO_FILE]: '未上传文件',
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
  [EVOLVED_SKILL_NOT_FOUND]: '进化技能不存在',
  [EVOLVED_SKILL_INVALID_STATUS]: '进化技能状态不允许此操作',
  [EVOLVED_SKILL_REVIEW_FAILED]: '进化技能审核失败',
  [WEBHOOK_NOT_FOUND]: 'Webhook 不存在',
  [WEBHOOK_LIMIT_EXCEEDED]: 'Webhook 数量已达上限',
  [WEBHOOK_DISABLED]: 'Webhook 已被禁用',

  // Chat Upload 错误
  [CHAT_UPLOAD_TOO_LARGE]: '上传文件超过大小限制 (最大 10MB)',
  [CHAT_UPLOAD_INVALID_TYPE]: '不支持的文件类型',
  [CHAT_UPLOAD_TOO_MANY_FILES]: '上传文件数量超过限制 (最多 5 个)',
  [CHAT_UPLOAD_NO_FILE]: '未检测到上传文件',

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

// ═══════════════════════════════════════════════════════════════
// 多语言错误消息映射
// ═══════════════════════════════════════════════════════════════

export type SupportedLocale = 'zh-CN' | 'en-US'

export const ERROR_MESSAGES_I18N: Record<SupportedLocale, Record<string, string>> = {
  'zh-CN': ERROR_MESSAGES,
  'en-US': {
    // 认证错误
    [AUTH_TOKEN_MISSING]: 'Authentication token is missing',
    [AUTH_TOKEN_INVALID]: 'Invalid authentication token',
    [AUTH_TOKEN_EXPIRED]: 'Authentication token has expired',
    [AUTH_API_KEY_INVALID]: 'Invalid API key',
    [AUTH_API_KEY_REVOKED]: 'API key has been revoked',
    [AUTH_API_KEY_EXPIRED]: 'API key has expired',
    [AUTH_PERMISSION_DENIED]: 'Permission denied',
    [AUTH_ORG_ACCESS_DENIED]: 'Access denied to this organization',
    [AUTH_USER_NOT_FOUND]: 'User not found',
    [AUTH_INVALID_PASSWORD]: 'Invalid password',
    [AUTH_EMAIL_EXISTS]: 'Email already registered',
    [AUTH_REFRESH_TOKEN_INVALID]: 'Invalid refresh token',
    [AUTH_REFRESH_TOKEN_EXPIRED]: 'Refresh token has expired',
    [AUTH_RESET_TOKEN_INVALID]: 'Invalid reset token',
    [AUTH_RESET_TOKEN_EXPIRED]: 'Reset token has expired',
    [AUTH_ORG_NOT_FOUND]: 'Organization not found',
    [AUTH_USER_INACTIVE]: 'User account is disabled',

    // 校验错误
    [VALIDATION_FAILED]: 'Validation failed',
    [VALIDATION_REQUIRED_FIELD]: 'Required field is missing',
    [VALIDATION_INVALID_FORMAT]: 'Invalid data format',
    [VALIDATION_OUT_OF_RANGE]: 'Value out of range',
    [VALIDATION_MESSAGE_TOO_LONG]: 'Message content is too long',

    // 资源错误
    [RESOURCE_NOT_FOUND]: 'Resource not found',
    [RESOURCE_ALREADY_EXISTS]: 'Resource already exists',
    [RESOURCE_CONFLICT]: 'Resource conflict',
    [RESOURCE_DELETED]: 'Resource has been deleted',
    [AGENT_NOT_FOUND]: 'Agent not found',
    [AGENT_INACTIVE]: 'Agent is inactive',
    [AGENT_LIMIT_EXCEEDED]: 'Agent limit exceeded',
    [AGENT_SYSTEM_READONLY]: 'System agent cannot be modified or deleted',
    [SKILL_NOT_FOUND]: 'Skill not found',
    [SKILL_LIMIT_EXCEEDED]: 'Skill limit exceeded',
    [SKILL_BUILTIN_READONLY]: 'Built-in skill is read-only',
    [SKILL_UPLOAD_TOO_LARGE]: 'Upload file exceeds size limit',
    [SKILL_UPLOAD_INVALID_TYPE]: 'Unsupported file type, only .zip/.tar.gz/.tgz allowed',
    [SKILL_UPLOAD_EXTRACT_FAILED]: 'Failed to extract file',
    [SKILL_UPLOAD_NO_FILE]: 'No file uploaded',
    [TOOL_NOT_FOUND]: 'Tool not found',
    [TOOL_LIMIT_EXCEEDED]: 'Tool limit exceeded',
    [TOOL_EXECUTION_FAILED]: 'Tool execution failed',
    [MCP_SERVER_NOT_FOUND]: 'MCP server not found',
    [MCP_SERVER_LIMIT_EXCEEDED]: 'MCP server limit exceeded',
    [MCP_CONNECTION_FAILED]: 'MCP server connection failed',
    [MCP_TOOL_CALL_FAILED]: 'MCP tool call failed',
    [SESSION_NOT_FOUND]: 'Session not found',
    [SESSION_ALREADY_COMPLETED]: 'Session has already ended',
    [SESSION_LIMIT_EXCEEDED]: 'Session limit exceeded',
    [MESSAGE_NOT_FOUND]: 'Message not found',
    [MESSAGE_LIMIT_EXCEEDED]: 'Message limit exceeded',
    [EVOLVED_SKILL_NOT_FOUND]: 'Evolved skill not found',
    [EVOLVED_SKILL_INVALID_STATUS]: 'Evolved skill status does not allow this operation',
    [EVOLVED_SKILL_REVIEW_FAILED]: 'Evolved skill review failed',
    [WEBHOOK_NOT_FOUND]: 'Webhook not found',
    [WEBHOOK_LIMIT_EXCEEDED]: 'Webhook limit exceeded',
    [WEBHOOK_DISABLED]: 'Webhook is disabled',

    // Chat Upload 错误
    [CHAT_UPLOAD_TOO_LARGE]: 'Upload file exceeds size limit (max 10MB)',
    [CHAT_UPLOAD_INVALID_TYPE]: 'Unsupported file type',
    [CHAT_UPLOAD_TOO_MANY_FILES]: 'Too many files (max 5)',
    [CHAT_UPLOAD_NO_FILE]: 'No file detected',

    // 限流错误
    [RATE_LIMIT_EXCEEDED]: 'Too many requests, please try again later',
    [RATE_LIMIT_USER]: 'User rate limit exceeded',
    [RATE_LIMIT_ORG]: 'Organization rate limit exceeded',
    [QUOTA_EXCEEDED]: 'Quota exhausted',
    [TOKEN_LIMIT_EXCEEDED]: 'Token usage limit exceeded',

    // 内部错误
    [INTERNAL_ERROR]: 'Internal server error',
    [DATABASE_ERROR]: 'Database error',
    [CACHE_ERROR]: 'Cache service error',
    [QUEUE_ERROR]: 'Queue service error',

    // 外部服务错误
    [EXTERNAL_LLM_ERROR]: 'LLM service call failed',
    [EXTERNAL_LLM_TIMEOUT]: 'LLM service response timeout',
    [LLM_UNAVAILABLE]: 'No available model service',
    [EXTERNAL_TOOL_ERROR]: 'Tool call failed',
    [EXTERNAL_TOOL_TIMEOUT]: 'Tool call timeout',
    [EXTERNAL_SERVICE_UNAVAILABLE]: 'External service unavailable',

    // SSE 错误
    [SSE_CONNECTION_FAILED]: 'SSE connection failed',
    [SSE_CONNECTION_LIMIT]: 'SSE connection limit reached',
    [SSE_STREAM_ERROR]: 'SSE stream error',
  },
}

/**
 * 根据 locale 获取错误消息
 */
export function getErrorMessage(code: string, locale?: string): string {
  const resolvedLocale = (locale === 'en-US' ? 'en-US' : 'zh-CN') as SupportedLocale
  return ERROR_MESSAGES_I18N[resolvedLocale]?.[code] ?? ERROR_MESSAGES[code] ?? '未知错误'
}
