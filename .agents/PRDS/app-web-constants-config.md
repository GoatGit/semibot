# PRD: 前端常量配置提取

## 概述

前端代码存在大量硬编码值，违反 `coding-standards.md` 规范，需要提取到统一配置文件。

## 问题描述

### 发现的硬编码值

```typescript
// 超时时间
setTimeout(resolve, 1500)  // chat/[sessionId]/page.tsx:66

// 动画延迟
animationDelay: '0.2s'    // chat/[sessionId]/page.tsx:111
animationDelay: '0.4s'    // chat/[sessionId]/page.tsx:114

// 路径配置
['/settings', '/agents']  // stores/layoutStore.ts:16

// 尺寸限制
maxHeight: '[200px]'      // chat/[sessionId]/page.tsx:158
max-w-[80%]              // chat/[sessionId]/page.tsx:224

// 示例密钥
'sk-prod-xxxxxxxxxxxxxxxxxxxx'  // settings/page.tsx:145
```

### 缺失文件

- `constants/config.ts` 不存在

## 目标

1. 创建统一的常量配置文件
2. 提取所有硬编码值
3. 确保符合编码规范

## 技术方案

### 1. 创建配置文件

```typescript
// constants/config.ts

// ============================================================================
// API 配置
// ============================================================================
export const API_CONFIG = {
  /** 请求超时时间（毫秒） */
  REQUEST_TIMEOUT: 30000,
  /** SSE 重连延迟（毫秒） */
  SSE_RECONNECT_DELAY: 5000,
  /** 最大重试次数 */
  MAX_RETRIES: 3,
} as const

// ============================================================================
// UI 配置
// ============================================================================
export const UI_CONFIG = {
  /** 消息最大长度 */
  MESSAGE_MAX_LENGTH: 2000,
  /** 文本域最大高度（像素） */
  TEXTAREA_MAX_HEIGHT: 200,
  /** 动画延迟步进（毫秒） */
  ANIMATION_DELAY_STEP: 200,
  /** 打字指示器延迟（毫秒） */
  TYPING_INDICATOR_DELAY: 1500,
  /** 消息气泡最大宽度百分比 */
  MESSAGE_BUBBLE_MAX_WIDTH: 80,
} as const

// ============================================================================
// 布局配置
// ============================================================================
export const LAYOUT_CONFIG = {
  /** 首页路径 */
  HOME_PATH: '/',
  /** 不需要详情面板的路径 */
  PATHS_WITHOUT_DETAIL: ['/settings', '/agents'] as const,
  /** 导航栏展开宽度（像素） */
  NAVBAR_EXPANDED_WIDTH: 240,
  /** 导航栏收起宽度（像素） */
  NAVBAR_COLLAPSED_WIDTH: 60,
  /** 详情面板宽度（像素） */
  DETAIL_CANVAS_WIDTH: 480,
} as const

// ============================================================================
// 存储键名
// ============================================================================
export const STORAGE_KEYS = {
  /** 布局状态 */
  LAYOUT_STATE: 'semibot-layout',
  /** 会话状态 */
  SESSION_STATE: 'semibot-session',
  /** 认证令牌 */
  AUTH_TOKEN: 'semibot-auth-token',
  /** 刷新令牌 */
  REFRESH_TOKEN: 'semibot-refresh-token',
} as const

// ============================================================================
// 动画配置
// ============================================================================
export const ANIMATION_CONFIG = {
  /** 淡入动画延迟（秒） */
  FADE_IN_DELAYS: [0.2, 0.4, 0.6] as const,
  /** 过渡持续时间（毫秒） */
  TRANSITION_DURATION: 200,
} as const

// ============================================================================
// 分页配置
// ============================================================================
export const PAGINATION_CONFIG = {
  /** 默认每页条数 */
  DEFAULT_PAGE_SIZE: 20,
  /** 最大每页条数 */
  MAX_PAGE_SIZE: 100,
} as const
```

### 2. 更新引用位置

```typescript
// Before
setTimeout(resolve, 1500)

// After
import { UI_CONFIG } from '@/constants/config'
setTimeout(resolve, UI_CONFIG.TYPING_INDICATOR_DELAY)
```

```typescript
// Before
const PATHS_WITHOUT_DETAIL = ['/settings', '/agents']

// After
import { LAYOUT_CONFIG } from '@/constants/config'
const { PATHS_WITHOUT_DETAIL } = LAYOUT_CONFIG
```

### 3. 需要更新的文件

| 文件 | 硬编码值 |
|------|----------|
| `chat/[sessionId]/page.tsx` | 1500ms, 0.2s, 0.4s, 200px, 80% |
| `stores/layoutStore.ts` | 路径数组, HOME_PATH |
| `settings/page.tsx` | 示例密钥格式 |
| `mcp/page.tsx` | 占位符文本 |
| `Sidebar.tsx` | 演示数据 |

## 验收标准

- [ ] `constants/config.ts` 文件创建完成
- [ ] 所有硬编码超时/延迟值已提取
- [ ] 所有硬编码路径已提取
- [ ] 边界值使用常量并打印日志
- [ ] ESLint 规则禁止新的硬编码值

## 优先级

**P0 - 阻塞性** - 违反编码规范

## 相关文件

- `apps/web/src/constants/config.ts` (新建)
- `apps/web/src/app/(dashboard)/chat/[sessionId]/page.tsx`
- `apps/web/src/stores/layoutStore.ts`
- `apps/web/src/app/(dashboard)/settings/page.tsx`
