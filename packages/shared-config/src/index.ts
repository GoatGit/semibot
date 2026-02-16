/**
 * @semibot/shared-config
 *
 * 前后端共享的配置常量
 * 避免重复定义，保证一致性
 */

// ═══════════════════════════════════════════════════════════════
// SSE 配置
// ═══════════════════════════════════════════════════════════════

/** SSE 心跳间隔 (毫秒) */
export const SSE_HEARTBEAT_INTERVAL_MS = 30000

/** SSE 连接超时 (毫秒) */
export const SSE_CONNECTION_TIMEOUT_MS = 600000

/** SSE 重连基础延迟 (毫秒) */
export const SSE_RECONNECT_BASE_DELAY_MS = 1000

/** SSE 重连最大延迟 (毫秒) */
export const SSE_RECONNECT_MAX_DELAY_MS = 30000

/** SSE 最大重试次数 */
export const SSE_MAX_RETRIES = 5

/** 心跳超时阈值 (毫秒) - 超过此时间未收到心跳则认为断线 */
export const SSE_HEARTBEAT_TIMEOUT_MS = 45000

// ═══════════════════════════════════════════════════════════════
// 限流配置
// ═══════════════════════════════════════════════════════════════

/** 每分钟请求限制 (用户级) */
export const RATE_LIMIT_PER_MINUTE_USER = 600

/** 每分钟请求限制 (组织级) */
export const RATE_LIMIT_PER_MINUTE_ORG = 3000

/** 限流窗口大小 (毫秒) */
export const RATE_LIMIT_WINDOW_MS = 60000

// ═══════════════════════════════════════════════════════════════
// 重试配置
// ═══════════════════════════════════════════════════════════════

/** 默认最大重试次数 */
export const DEFAULT_MAX_RETRIES = 3

/** 重试基础延迟 (毫秒) */
export const RETRY_BASE_DELAY_MS = 1000

/** 重试最大延迟 (毫秒) */
export const RETRY_MAX_DELAY_MS = 10000

/** 重试退避倍数 */
export const RETRY_BACKOFF_MULTIPLIER = 2

// ═══════════════════════════════════════════════════════════════
// 分页配置
// ═══════════════════════════════════════════════════════════════

/** 默认分页大小 */
export const DEFAULT_PAGE_SIZE = 20

/** 最大分页大小 */
export const MAX_PAGE_SIZE = 100

/** 默认页码 */
export const DEFAULT_PAGE = 1

// ═══════════════════════════════════════════════════════════════
// 限制配置
// ═══════════════════════════════════════════════════════════════

/** 最大消息长度 (字符) */
export const MAX_MESSAGE_LENGTH = 100000

/** 最大会话消息数 */
export const MAX_SESSION_MESSAGES = 1000

/** 最大并发 SSE 连接数 (用户级) */
export const MAX_SSE_CONNECTIONS_PER_USER = 5

/** 最大并发 SSE 连接数 (组织级) */
export const MAX_SSE_CONNECTIONS_PER_ORG = 50

// ═══════════════════════════════════════════════════════════════
// API 配置
// ═══════════════════════════════════════════════════════════════

/** API 基础路径 */
export const API_BASE_PATH = '/api/v1'

/** 默认请求超时时间 (毫秒) */
export const DEFAULT_TIMEOUT_MS = 30000
