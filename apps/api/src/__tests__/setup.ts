/**
 * Vitest 测试设置文件
 */

import { vi, beforeAll, afterAll, beforeEach } from 'vitest'

// 模拟环境变量
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'
process.env.JWT_SECRET = 'test-secret-key-for-testing'

// 全局测试前钩子
beforeAll(() => {
  // 初始化测试环境
})

// 全局测试后钩子
afterAll(() => {
  // 清理测试环境
})

// 每个测试前钩子
beforeEach(() => {
  // 重置 mock
  vi.clearAllMocks()
})
