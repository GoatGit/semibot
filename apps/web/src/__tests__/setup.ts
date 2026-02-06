/**
 * Vitest 测试设置文件 - Web 应用
 */

import '@testing-library/jest-dom/vitest'
import { vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(window, 'localStorage', { value: localStorageMock })

// Mock fetch
global.fetch = vi.fn()

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
  vi.clearAllMocks()
})

// 每个测试后清理 DOM
afterEach(() => {
  cleanup()
})
