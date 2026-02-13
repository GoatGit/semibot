import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright E2E 测试配置
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  // 测试文件目录
  testDir: '.',

  // 测试文件匹配模式
  testMatch: '**/*.spec.ts',

  // 完全并行运行测试
  fullyParallel: true,

  // CI 环境下禁止 test.only
  forbidOnly: !!process.env.CI,

  // CI 环境下重试失败的测试
  retries: process.env.CI ? 2 : 0,

  // CI 环境下限制并行 worker 数量
  workers: process.env.CI ? 1 : undefined,

  // 测试报告配置
  reporter: [
    ['html', { outputFolder: '../playwright-report' }],
    ['list'],
  ],

  // 全局测试配置
  use: {
    // 基础 URL
    baseURL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3100',

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
    command: 'pnpm --filter @semibot/web dev',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    cwd: '../..',
  },

  // 输出目录
  outputDir: '../test-results',
})
