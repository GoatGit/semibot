import type { Page } from '@playwright/test'

let cachedToken: string | null = null

const TEST_EMAIL = process.env.E2E_TEST_EMAIL || '12611171@qq.com'
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD || 'test123'
const TEST_NAME = process.env.E2E_TEST_NAME || 'E2E User'
const TEST_ORG = process.env.E2E_TEST_ORG || 'E2E Org'

function resolveApiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL || process.env.API_URL
  if (fromEnv && fromEnv.trim()) {
    const normalized = fromEnv.replace(/\/$/, '')
    return normalized.endsWith('/api/v1') ? normalized : `${normalized}/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

async function parseResponseSafe(res: Awaited<ReturnType<Page['request']['post']>>) {
  const text = await res.text()
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    return {
      success: false,
      error: { message: `Non-JSON response: ${text.slice(0, 200)}` },
    }
  }
}

/**
 * Login via API and inject token into browser storage.
 * Caches token to reduce repeated login requests in one run.
 */
export async function loginByApi(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })

  if (!cachedToken) {
    const apiBase = resolveApiBase()
    const maxRetries = 5
    let loginResult: { success: boolean; token?: string; error?: string } = {
      success: false,
      error: 'Login retries exhausted',
    }

    for (let i = 0; i < maxRetries; i++) {
      const loginRes = await page.request.post(`${apiBase}/auth/login`, {
        data: { email: TEST_EMAIL, password: TEST_PASSWORD },
      })
      const loginData = await parseResponseSafe(loginRes)

      if (loginRes.ok() && loginData.success && loginData.data?.token) {
        loginResult = { success: true, token: String(loginData.data.token) }
        break
      }

      const code = String(loginData?.error?.code || '')
      if (loginRes.status() === 404 || code === 'AUTH_USER_NOT_FOUND') {
        const registerRes = await page.request.post(`${apiBase}/auth/register`, {
          data: {
            email: TEST_EMAIL,
            password: TEST_PASSWORD,
            name: TEST_NAME,
            orgName: TEST_ORG,
          },
        })
        const registerData = await parseResponseSafe(registerRes)
        // 已注册用户（并发/重试场景）或注册成功，都允许继续重试登录
        const registerCode = String(registerData?.error?.code || '')
        if (!(registerRes.ok() || registerCode === 'AUTH_EMAIL_ALREADY_EXISTS')) {
          loginResult = {
            success: false,
            error: registerData?.error?.message || `Register failed: HTTP ${registerRes.status()}`,
          }
          break
        }
      }

      if (loginRes.status() === 429) {
        await page.waitForTimeout(3000 * (i + 1))
        continue
      }

      loginResult = {
        success: false,
        error: loginData?.error?.message || `Login failed: HTTP ${loginRes.status()}`,
      }
      break
    }

    if (!loginResult.success || !loginResult.token) {
      throw new Error(`Login failed: ${loginResult.error || 'Unknown error'}`)
    }

    cachedToken = loginResult.token
  }

  await page.evaluate((token) => {
    document.cookie = `auth_token=${token}; path=/; max-age=86400; samesite=strict`
    localStorage.setItem('auth_token', token)
  }, cachedToken)

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 10000 })
}
