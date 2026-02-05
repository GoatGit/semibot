/**
 * API 服务常量配置
 *
 * 遵循编码规范：所有数值常量必须定义在此文件中，禁止硬编码
 *
 * 注意：前后端共享的常量从 @semibot/shared-config 导入
 */

// 从共享配置包导入前后端通用常量
export {
  // SSE 配置
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_CONNECTION_TIMEOUT_MS,
  SSE_RECONNECT_BASE_DELAY_MS,
  SSE_RECONNECT_MAX_DELAY_MS,
  SSE_MAX_RETRIES,
  // 限流配置
  RATE_LIMIT_PER_MINUTE_USER,
  RATE_LIMIT_PER_MINUTE_ORG,
  RATE_LIMIT_WINDOW_MS,
  // 重试配置
  DEFAULT_MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_BACKOFF_MULTIPLIER,
  // 分页配置
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE,
  // 限制配置
  MAX_MESSAGE_LENGTH,
  MAX_SESSION_MESSAGES,
  MAX_SSE_CONNECTIONS_PER_USER,
} from '@semibot/shared-config'

// ═══════════════════════════════════════════════════════════════
// 服务器配置 (仅后端使用)
// ═══════════════════════════════════════════════════════════════

/** 服务器端口 */
export const SERVER_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001

/** 服务器主机 */
export const SERVER_HOST = process.env.HOST ?? '0.0.0.0'

// ═══════════════════════════════════════════════════════════════
// 限流配置 (仅后端使用)
// ═══════════════════════════════════════════════════════════════

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
// 超时配置 (仅后端使用)
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
// 限制配置 (仅后端使用)
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// LLM 提供商配置
// ═══════════════════════════════════════════════════════════════

/** OpenAI 配置 */
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? ''
export const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1'
export const OPENAI_ORG_ID = process.env.OPENAI_ORG_ID ?? ''

/** Anthropic 配置 */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''
export const ANTHROPIC_API_BASE_URL = process.env.ANTHROPIC_API_BASE_URL ?? 'https://api.anthropic.com'

/** Google AI 配置 */
export const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY ?? ''
export const GOOGLE_AI_API_BASE_URL = process.env.GOOGLE_AI_API_BASE_URL ?? 'https://generativelanguage.googleapis.com'

/** Azure OpenAI 配置 */
export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY ?? ''
export const AZURE_OPENAI_API_BASE_URL = process.env.AZURE_OPENAI_API_BASE_URL ?? ''
export const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION ?? '2024-02-15-preview'
export const AZURE_OPENAI_DEPLOYMENT_NAME = process.env.AZURE_OPENAI_DEPLOYMENT_NAME ?? ''

/** 自定义 LLM 配置 (兼容 OpenAI API 的第三方服务) */
export const CUSTOM_LLM_API_KEY = process.env.CUSTOM_LLM_API_KEY ?? ''
export const CUSTOM_LLM_API_BASE_URL = process.env.CUSTOM_LLM_API_BASE_URL ?? ''
export const CUSTOM_LLM_MODEL_NAME = process.env.CUSTOM_LLM_MODEL_NAME ?? ''

/** 默认 LLM 提供商 */
export const DEFAULT_LLM_PROVIDER = process.env.DEFAULT_LLM_PROVIDER ?? 'openai'

/** 默认模型名称 */
export const DEFAULT_MODEL_NAME = process.env.DEFAULT_MODEL_NAME ?? 'gpt-4o'

/**
 * 获取 LLM 配置
 */
export interface LLMProviderConfig {
  apiKey: string
  baseUrl: string
  orgId?: string
  apiVersion?: string
  deploymentName?: string
  modelName?: string
}

export function getLLMConfig(provider: string): LLMProviderConfig | null {
  switch (provider) {
    case 'openai':
      if (!OPENAI_API_KEY) return null
      return {
        apiKey: OPENAI_API_KEY,
        baseUrl: OPENAI_API_BASE_URL,
        orgId: OPENAI_ORG_ID || undefined,
      }
    case 'anthropic':
      if (!ANTHROPIC_API_KEY) return null
      return {
        apiKey: ANTHROPIC_API_KEY,
        baseUrl: ANTHROPIC_API_BASE_URL,
      }
    case 'google':
      if (!GOOGLE_AI_API_KEY) return null
      return {
        apiKey: GOOGLE_AI_API_KEY,
        baseUrl: GOOGLE_AI_API_BASE_URL,
      }
    case 'azure':
      if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_BASE_URL) return null
      return {
        apiKey: AZURE_OPENAI_API_KEY,
        baseUrl: AZURE_OPENAI_API_BASE_URL,
        apiVersion: AZURE_OPENAI_API_VERSION,
        deploymentName: AZURE_OPENAI_DEPLOYMENT_NAME || undefined,
      }
    case 'custom':
      if (!CUSTOM_LLM_API_KEY || !CUSTOM_LLM_API_BASE_URL) return null
      return {
        apiKey: CUSTOM_LLM_API_KEY,
        baseUrl: CUSTOM_LLM_API_BASE_URL,
        modelName: CUSTOM_LLM_MODEL_NAME || undefined,
      }
    default:
      return null
  }
}

/**
 * 获取所有已配置的 LLM 提供商
 */
export function getConfiguredLLMProviders(): string[] {
  const providers: string[] = []
  if (OPENAI_API_KEY) providers.push('openai')
  if (ANTHROPIC_API_KEY) providers.push('anthropic')
  if (GOOGLE_AI_API_KEY) providers.push('google')
  if (AZURE_OPENAI_API_KEY && AZURE_OPENAI_API_BASE_URL) providers.push('azure')
  if (CUSTOM_LLM_API_KEY && CUSTOM_LLM_API_BASE_URL) providers.push('custom')
  return providers
}
