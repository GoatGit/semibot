/**
 * 前端常量配置
 *
 * 所有硬编码值都应在此文件中定义
 * 禁止在代码中直接使用魔法数字
 */

// 从 shared-config 重新导出公共配置
export {
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_CONNECTION_TIMEOUT_MS,
  SSE_RECONNECT_BASE_DELAY_MS,
  SSE_RECONNECT_MAX_DELAY_MS,
  SSE_MAX_RETRIES,
  SSE_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE,
  MAX_MESSAGE_LENGTH,
  MAX_SESSION_MESSAGES,
  API_BASE_PATH,
  DEFAULT_TIMEOUT_MS,
} from '@semibot/shared-config'

// ═══════════════════════════════════════════════════════════════
// UI 配置
// ═══════════════════════════════════════════════════════════════

/** 打字指示器动画延迟 (秒) */
export const TYPING_INDICATOR_DELAYS = {
  DOT_1: 0,
  DOT_2: 0.2,
  DOT_3: 0.4,
} as const

/** 消息输入框最大高度 (像素) */
export const MESSAGE_INPUT_MAX_HEIGHT_PX = 200

/** 消息输入框最小高度 (像素) */
export const MESSAGE_INPUT_MIN_HEIGHT_PX = 24

/** 消息输入框换行阈值 (行数) */
export const MESSAGE_INPUT_OVERFLOW_LINES = 5

/** 消息气泡最大宽度 (百分比) */
export const MESSAGE_BUBBLE_MAX_WIDTH_PERCENT = 80

// ═══════════════════════════════════════════════════════════════
// 布局配置
// ═══════════════════════════════════════════════════════════════

/** 不需要显示详情画布的路径 */
export const PATHS_WITHOUT_DETAIL = ['/settings', '/agents'] as const

/** 首页路径 */
export const HOME_PATH = '/'

/** 侧边导航宽度 (像素) */
export const SIDEBAR_NAV_WIDTH_PX = 224 // w-56 = 14rem = 224px

/** 详情画布展开宽度 (像素) */
export const DETAIL_CANVAS_WIDTH_PX = 640

/** 一天的毫秒数 */
export const MS_PER_DAY = 1000 * 60 * 60 * 24

/** 显示"X天前"的天数阈值 */
export const RELATIVE_TIME_DAYS_THRESHOLD = 7

/** 设置页面内容最大宽度 */
export const SETTINGS_CONTENT_MAX_WIDTH = '2xl' // max-w-2xl

/** 聊天区域最大宽度 */
export const CHAT_CONTENT_MAX_WIDTH = '3xl' // max-w-3xl

// ═══════════════════════════════════════════════════════════════
// 存储键名
// ═══════════════════════════════════════════════════════════════

/** 本地存储键名 */
export const STORAGE_KEYS = {
  /** 认证 Token */
  AUTH_TOKEN: 'auth_token',
  /** 刷新 Token */
  REFRESH_TOKEN: 'refresh_token',
  /** 用户偏好设置 */
  USER_PREFERENCES: 'user_preferences',
  /** 主题设置 */
  THEME: 'theme',
  /** 语言设置 */
  LANGUAGE: 'language',
  /** 最近访问的会话 */
  RECENT_SESSIONS: 'recent_sessions',
} as const

// ═══════════════════════════════════════════════════════════════
// 动画配置
// ═══════════════════════════════════════════════════════════════

/** 动画持续时间 (毫秒) */
export const ANIMATION_DURATION = {
  /** 快速动画 */
  FAST: 150,
  /** 标准动画 */
  NORMAL: 200,
  /** 慢速动画 */
  SLOW: 300,
} as const

/** 过渡类名 */
export const TRANSITION_CLASSES = {
  FAST: 'transition-all duration-fast',
  NORMAL: 'transition-all duration-normal',
  SLOW: 'transition-all duration-slow',
} as const

// ═══════════════════════════════════════════════════════════════
// MCP 服务器配置
// ═══════════════════════════════════════════════════════════════

/** MCP 服务器类型 */
export const MCP_SERVER_TYPES = ['stdio', 'sse', 'http'] as const

/** MCP 服务器状态 */
export const MCP_SERVER_STATUS = ['connected', 'disconnected', 'error'] as const

/** 服务器卡片工具标签显示数量 */
export const MCP_TOOLS_DISPLAY_LIMIT = 3

// ═══════════════════════════════════════════════════════════════
// API 密钥配置
// ═══════════════════════════════════════════════════════════════

/** API 密钥遮罩前缀长度 */
export const API_KEY_MASK_PREFIX_LENGTH = 7

/** API 密钥遮罩后缀长度 */
export const API_KEY_MASK_SUFFIX_LENGTH = 4

/** API 密钥遮罩字符数量 */
export const API_KEY_MASK_CHAR_COUNT = 20

// ═══════════════════════════════════════════════════════════════
// 表单验证配置
// ═══════════════════════════════════════════════════════════════

/** 用户名长度限制 */
export const USERNAME_LENGTH = {
  MIN: 3,
  MAX: 50,
} as const

/** 密码长度限制 */
export const PASSWORD_LENGTH = {
  MIN: 8,
  MAX: 128,
} as const

/** 邮箱最大长度 */
export const EMAIL_MAX_LENGTH = 254

/** 个人简介最大长度 */
export const BIO_MAX_LENGTH = 500

// ═══════════════════════════════════════════════════════════════
// 主题配置
// ═══════════════════════════════════════════════════════════════

/** 可用主题 */
export const THEMES = ['dark', 'light', 'system'] as const

/** 默认主题 */
export const DEFAULT_THEME = 'dark' as const

// ═══════════════════════════════════════════════════════════════
// 语言配置
// ═══════════════════════════════════════════════════════════════

/** 可用语言 */
export const LANGUAGES = ['zh-CN', 'en-US'] as const

/** 默认语言 */
export const DEFAULT_LANGUAGE = 'zh-CN' as const

// ═══════════════════════════════════════════════════════════════
// 时间格式配置
// ═══════════════════════════════════════════════════════════════

/** 时间格式选项 */
export const TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
}

/** 日期格式选项 */
export const DATE_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}

/** 时区 */
export const DEFAULT_LOCALE = 'zh-CN'
