/**
 * API 服务常量配置
 *
 * 遵循编码规范：所有数值常量必须定义在此文件中，禁止硬编码
 */

// ═══════════════════════════════════════════════════════════════
// 服务器配置
// ═══════════════════════════════════════════════════════════════

/** 服务器端口 */
export const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001

/** 服务器主机 */
export const SERVER_HOST = process.env.HOST ?? '0.0.0.0'

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

// ═══════════════════════════════════════════════════════════════
// 限流配置
// ═══════════════════════════════════════════════════════════════

/** 每分钟请求限制 (用户级) */
export const RATE_LIMIT_PER_MINUTE_USER = 60

/** 每分钟请求限制 (组织级) */
export const RATE_LIMIT_PER_MINUTE_ORG = 600

/** 限流窗口大小 (毫秒) */
export const RATE_LIMIT_WINDOW_MS = 60000

/** 限流超限后等待时间 (毫秒) */
export const RATE_LIMIT_RETRY_AFTER_MS = 60000

// ═══════════════════════════════════════════════════════════════
// 认证配置
// ═══════════════════════════════════════════════════════════════

/** JWT 过期时间 (秒) */
export const JWT_EXPIRES_IN_SECONDS = 86400 // 24 小时

/** JWT 刷新 Token 过期时间 (秒) */
export const JWT_REFRESH_EXPIRES_IN_SECONDS = 604800 // 7 天

/** API Key 前缀 */
export const API_KEY_PREFIX = 'sk-'

/** API Key 长度 (字节) */
export const API_KEY_LENGTH_BYTES = 32

/** bcrypt 哈希轮数 */
export const BCRYPT_ROUNDS = 12

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
// 超时配置
// ═══════════════════════════════════════════════════════════════

/** LLM 调用超时 (毫秒) - 简单请求 */
export const LLM_TIMEOUT_SIMPLE_MS = 30000

/** LLM 调用超时 (毫秒) - 复杂推理 */
export const LLM_TIMEOUT_COMPLEX_MS = 120000

/** 工具调用超时 (毫秒) - Web 搜索 */
export const TOOL_TIMEOUT_WEB_SEARCH_MS = 15000

/** 工具调用超时 (毫秒) - 代码执行 */
export const TOOL_TIMEOUT_CODE_EXECUTOR_MS = 60000

/** 工具调用超时 (毫秒) - 浏览器控制 */
export const TOOL_TIMEOUT_BROWSER_MS = 30000

/** 单步骤总超时 (毫秒) */
export const STEP_TIMEOUT_MS = 180000

/** 整体会话超时 (毫秒) */
export const SESSION_TIMEOUT_MS = 600000

/** 数据库查询超时 (毫秒) */
export const DB_QUERY_TIMEOUT_MS = 30000

// ═══════════════════════════════════════════════════════════════
// 缓存配置
// ═══════════════════════════════════════════════════════════════

/** 会话缓存 TTL (秒) */
export const SESSION_CACHE_TTL_SECONDS = 3600

/** Agent 配置缓存 TTL (秒) */
export const AGENT_CACHE_TTL_SECONDS = 300

/** API Key 黑名单 TTL (秒) */
export const API_KEY_BLACKLIST_TTL_SECONDS = 86400

// ═══════════════════════════════════════════════════════════════
// 限制配置
// ═══════════════════════════════════════════════════════════════

/** 最大消息长度 (字符) */
export const MAX_MESSAGE_LENGTH = 100000

/** 最大会话消息数 */
export const MAX_SESSION_MESSAGES = 1000

/** 最大并发 SSE 连接数 (用户级) */
export const MAX_SSE_CONNECTIONS_PER_USER = 5

/** 最大并发 Agent 执行数 (用户级) */
export const MAX_CONCURRENT_AGENTS_PER_USER = 3

/** 最大并发 Agent 执行数 (组织级) */
export const MAX_CONCURRENT_AGENTS_PER_ORG = 20

/** 最大文件上传大小 (字节) */
export const MAX_FILE_UPLOAD_SIZE_BYTES = 10485760 // 10MB

// ═══════════════════════════════════════════════════════════════
// Redis 配置
// ═══════════════════════════════════════════════════════════════

/** Redis 连接 URL */
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'

/** Redis 连接池大小 */
export const REDIS_POOL_SIZE = 10

/** Redis 命令超时 (毫秒) */
export const REDIS_COMMAND_TIMEOUT_MS = 5000

// ═══════════════════════════════════════════════════════════════
// 数据库配置
// ═══════════════════════════════════════════════════════════════

/** 数据库连接 URL */
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/semibot'

/** 数据库连接池最小连接数 */
export const DB_POOL_MIN = 2

/** 数据库连接池最大连接数 */
export const DB_POOL_MAX = 10

// ═══════════════════════════════════════════════════════════════
// 日志配置
// ═══════════════════════════════════════════════════════════════

/** 日志级别 */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info'

/** 是否启用请求日志 */
export const ENABLE_REQUEST_LOGGING = process.env.ENABLE_REQUEST_LOGGING !== 'false'
