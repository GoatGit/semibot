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
export declare const AUTH_TOKEN_MISSING = "AUTH_TOKEN_MISSING";
export declare const AUTH_TOKEN_INVALID = "AUTH_TOKEN_INVALID";
export declare const AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED";
export declare const AUTH_API_KEY_INVALID = "AUTH_API_KEY_INVALID";
export declare const AUTH_API_KEY_REVOKED = "AUTH_API_KEY_REVOKED";
export declare const AUTH_API_KEY_EXPIRED = "AUTH_API_KEY_EXPIRED";
export declare const AUTH_PERMISSION_DENIED = "AUTH_PERMISSION_DENIED";
export declare const AUTH_ORG_ACCESS_DENIED = "AUTH_ORG_ACCESS_DENIED";
export declare const VALIDATION_FAILED = "VALIDATION_FAILED";
export declare const VALIDATION_REQUIRED_FIELD = "VALIDATION_REQUIRED_FIELD";
export declare const VALIDATION_INVALID_FORMAT = "VALIDATION_INVALID_FORMAT";
export declare const VALIDATION_OUT_OF_RANGE = "VALIDATION_OUT_OF_RANGE";
export declare const VALIDATION_MESSAGE_TOO_LONG = "VALIDATION_MESSAGE_TOO_LONG";
export declare const RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND";
export declare const RESOURCE_ALREADY_EXISTS = "RESOURCE_ALREADY_EXISTS";
export declare const RESOURCE_CONFLICT = "RESOURCE_CONFLICT";
export declare const RESOURCE_DELETED = "RESOURCE_DELETED";
export declare const AGENT_NOT_FOUND = "AGENT_NOT_FOUND";
export declare const AGENT_INACTIVE = "AGENT_INACTIVE";
export declare const AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED";
export declare const SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
export declare const SESSION_ALREADY_COMPLETED = "SESSION_ALREADY_COMPLETED";
export declare const SESSION_LIMIT_EXCEEDED = "SESSION_LIMIT_EXCEEDED";
export declare const MESSAGE_NOT_FOUND = "MESSAGE_NOT_FOUND";
export declare const MESSAGE_LIMIT_EXCEEDED = "MESSAGE_LIMIT_EXCEEDED";
export declare const RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED";
export declare const RATE_LIMIT_USER = "RATE_LIMIT_USER";
export declare const RATE_LIMIT_ORG = "RATE_LIMIT_ORG";
export declare const QUOTA_EXCEEDED = "QUOTA_EXCEEDED";
export declare const TOKEN_LIMIT_EXCEEDED = "TOKEN_LIMIT_EXCEEDED";
export declare const INTERNAL_ERROR = "INTERNAL_ERROR";
export declare const DATABASE_ERROR = "DATABASE_ERROR";
export declare const CACHE_ERROR = "CACHE_ERROR";
export declare const QUEUE_ERROR = "QUEUE_ERROR";
export declare const EXTERNAL_LLM_ERROR = "EXTERNAL_LLM_ERROR";
export declare const EXTERNAL_LLM_TIMEOUT = "EXTERNAL_LLM_TIMEOUT";
export declare const EXTERNAL_TOOL_ERROR = "EXTERNAL_TOOL_ERROR";
export declare const EXTERNAL_TOOL_TIMEOUT = "EXTERNAL_TOOL_TIMEOUT";
export declare const EXTERNAL_SERVICE_UNAVAILABLE = "EXTERNAL_SERVICE_UNAVAILABLE";
export declare const SSE_CONNECTION_FAILED = "SSE_CONNECTION_FAILED";
export declare const SSE_CONNECTION_LIMIT = "SSE_CONNECTION_LIMIT";
export declare const SSE_STREAM_ERROR = "SSE_STREAM_ERROR";
export declare const ERROR_HTTP_STATUS: Record<string, number>;
export declare const ERROR_MESSAGES: Record<string, string>;
//# sourceMappingURL=errorCodes.d.ts.map