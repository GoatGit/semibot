/**
 * API 客户端封装
 *
 * 提供统一的 API 请求方法，支持认证、错误处理、重试等功能
 */

import {
  API_BASE_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
} from '@semibot/shared-config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** 请求参数 (GET 时作为 query string) */
  params?: Record<string, unknown>
  /** 请求体 */
  body?: unknown
  /** 超时时间 (毫秒) */
  timeout?: number
  /** 是否重试 */
  retry?: boolean
  /** 最大重试次数 */
  maxRetries?: number
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 获取 API 基础 URL
 */
export function getApiBaseUrl(): string {
  // 优先使用环境变量
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL
  }

  // 浏览器环境使用相对路径
  if (typeof window !== 'undefined') {
    return API_BASE_PATH
  }

  // 服务端默认
  return `http://localhost:3001${API_BASE_PATH}`
}

/**
 * 获取认证 Token
 */
function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('auth_token')
}

/**
 * 构建 URL 查询字符串
 */
function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value))
    }
  }

  return searchParams.toString()
}

/**
 * 计算重试延迟 (指数退避)
 */
function getRetryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), 10000)
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 判断是否应该重试
 */
function shouldRetry(status: number): boolean {
  // 5xx 服务器错误和 429 限流可以重试
  return status >= 500 || status === 429
}

// ═══════════════════════════════════════════════════════════════
// API 客户端实现
// ═══════════════════════════════════════════════════════════════

/**
 * 发起 API 请求
 */
async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const {
    params,
    body,
    timeout = DEFAULT_TIMEOUT_MS,
    retry = true,
    maxRetries = DEFAULT_MAX_RETRIES,
    headers: customHeaders,
    ...fetchOptions
  } = options

  // 构建 URL
  const baseUrl = getApiBaseUrl()
  let url = `${baseUrl}${path}`

  if (params) {
    const queryString = buildQueryString(params)
    if (queryString) {
      url += `?${queryString}`
    }
  }

  // 构建请求头
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(customHeaders as Record<string, string>),
  }

  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // 请求配置
  const requestInit: RequestInit = {
    method,
    headers,
    ...fetchOptions,
  }

  if (body && method !== 'GET') {
    requestInit.body = JSON.stringify(body)
  }

  // 执行请求 (带重试)
  let lastError: Error | null = null
  let attempt = 0

  while (attempt <= maxRetries) {
    try {
      // 创建超时控制
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        ...requestInit,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      // 解析响应
      const data = await response.json()

      // 检查是否需要重试
      if (!response.ok && retry && shouldRetry(response.status) && attempt < maxRetries) {
        const retryDelay = getRetryDelay(attempt)
        console.warn(
          `[API] 请求失败，准备重试 - ${method} ${path}, 状态: ${response.status}, 第 ${attempt + 1}/${maxRetries} 次，延迟 ${retryDelay}ms`
        )
        await delay(retryDelay)
        attempt++
        continue
      }

      return data as T
    } catch (error) {
      lastError = error as Error

      // 网络错误可以重试
      if (retry && attempt < maxRetries && (error as Error).name !== 'AbortError') {
        const retryDelay = getRetryDelay(attempt)
        console.warn(
          `[API] 请求异常，准备重试 - ${method} ${path}, 错误: ${(error as Error).message}, 第 ${attempt + 1}/${maxRetries} 次，延迟 ${retryDelay}ms`
        )
        await delay(retryDelay)
        attempt++
        continue
      }

      break
    }
  }

  // 所有重试都失败
  console.error(`[API] 请求失败 - ${method} ${path}`, lastError)
  throw lastError ?? new Error('请求失败')
}

// ═══════════════════════════════════════════════════════════════
// 导出 API 客户端
// ═══════════════════════════════════════════════════════════════

export const apiClient = {
  /**
   * GET 请求
   */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('GET', path, options)
  },

  /**
   * POST 请求
   */
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('POST', path, { ...options, body })
  },

  /**
   * PUT 请求
   */
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, { ...options, body })
  },

  /**
   * PATCH 请求
   */
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PATCH', path, { ...options, body })
  },

  /**
   * DELETE 请求
   */
  delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, options)
  },

  /**
   * 文件上传请求 (FormData)
   *
   * 不设置 Content-Type，让浏览器自动设置 multipart boundary
   */
  async upload<T>(path: string, formData: FormData, options: RequestOptions = {}): Promise<T> {
    const {
      timeout = 120000,
      retry = true,
      maxRetries = DEFAULT_MAX_RETRIES,
      headers: customHeaders,
    } = options

    const baseUrl = getApiBaseUrl()
    const url = `${baseUrl}${path}`

    const headers: Record<string, string> = {
      ...(customHeaders as Record<string, string>),
    }

    const token = getAuthToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let lastError: Error | null = null
    let attempt = 0

    while (attempt <= maxRetries) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        })

        clearTimeout(timeoutId)

        const data = await response.json()

        if (!response.ok && retry && shouldRetry(response.status) && attempt < maxRetries) {
          const retryDelay = getRetryDelay(attempt)
          await delay(retryDelay)
          attempt++
          continue
        }

        return data as T
      } catch (error) {
        lastError = error as Error

        if (retry && attempt < maxRetries && (error as Error).name !== 'AbortError') {
          const retryDelay = getRetryDelay(attempt)
          await delay(retryDelay)
          attempt++
          continue
        }

        break
      }
    }

    throw lastError ?? new Error('上传请求失败')
  },
}

export default apiClient
