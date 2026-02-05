/**
 * Jest 测试设置文件
 */

// 设置测试超时
jest.setTimeout(30000)

// 模拟环境变量
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = 'error'

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
  jest.clearAllMocks()
})
