import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E 测试配置
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // 优先使用环境变量中的应用地址，便于与 .env.local 对齐
  // 例如 NEXT_PUBLIC_APP_URL=http://localhost:3100
  // 若未设置则回退到 3000
  // 仅用于测试配置，不影响业务代码
  // 测试文件目录
  testDir: '.',

  // 测试文件匹配模式
  testMatch: '**/*.spec.ts',

  // Next.js dev server 在高并发下容易出现热更新抖动，默认串行文件级执行
  fullyParallel: false,

  // CI 环境下禁止 test.only
  forbidOnly: !!process.env.CI,

  // CI 环境下重试失败的测试
  retries: process.env.CI ? 2 : 0,

  // 控制并发，降低本地 dev server 抖动导致的偶发失败
  workers: process.env.CI ? 1 : 2,

  // 测试报告配置
  reporter: [
    ['html', { outputFolder: '../playwright-report' }],
    ['list'],
  ],

  // 全局测试配置
  use: {
    // 基础 URL
    baseURL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',

    // 请求追踪 - 仅在首次重试时收集
    trace: 'on-first-retry',

    // 失败时截图
    screenshot: 'only-on-failure',

    // 失败时录制视频
    video: 'on-first-retry',

    // 默认超时配置
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },

  // 全局超时
  timeout: 30000,

  // 期望超时
  expect: {
    timeout: 5000,
  },

  // 多浏览器配置
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
      },
    },
    // 移动端测试配置
    {
      name: 'mobile-chrome',
      use: {
        ...devices['Pixel 5'],
      },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 12'],
      },
    },
  ],

  // 开发服务器配置
  webServer: {
    // 清理 .next，避免因增量缓存导致 vendor chunk 丢失（MODULE_NOT_FOUND）
    command: 'rm -rf apps/web/.next && pnpm --filter @semibot/web dev',
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    // 默认不复用本地已运行的 dev server，避免命中陈旧构建导致前端 JS 404
    // 如需复用可显式设置 PW_REUSE_SERVER=1
    reuseExistingServer: process.env.PW_REUSE_SERVER === '1',
    timeout: 120000,
    cwd: '../..',
  },

  // 输出目录
  outputDir: '../test-results',
})
