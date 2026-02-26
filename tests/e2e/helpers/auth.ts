import type { Page } from '@playwright/test'

/**
 * V2 单用户无鉴权模式：
 * 仅确保浏览器状态与默认用户上下文一致，不再调用 /auth/login。
 */
export async function loginByApi(page: Page) {
  await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({
        state: {
          user: {
            id: 'e2e-single-user',
            email: 'admin@semibot.local',
            name: 'Semibot Admin',
            role: 'owner',
            orgId: '11111111-1111-1111-1111-111111111111',
            orgName: 'Semibot',
          },
          tokens: null,
          isAuthenticated: true,
        },
        version: 0,
      })
    )
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
}
