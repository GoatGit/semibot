import { test, expect, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

interface NoAuthMockOptions {
  runtimeTools?: string[]
  dbTools?: Array<{
    id: string
    name: string
    type: string
    description?: string
    isBuiltin: boolean
    isActive: boolean
  }>
}

async function setupCommonMocks(page: Page, options: NoAuthMockOptions = {}) {
  const runtimeTools = options.runtimeTools ?? []
  const dbTools = options.dbTools ?? []

  await page.route('**/api/v1/**', async (route, request) => {
    const { pathname } = new URL(request.url())

    if (pathname.endsWith('/sessions') && request.method() === 'GET') {
      await json(route, {
        success: true,
        data: [],
        meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
      })
      return
    }

    if (pathname.endsWith('/users/preferences') && request.method() === 'GET') {
      await json(route, {
        success: true,
        data: { theme: 'light', language: 'zh-CN' },
      })
      return
    }

    if (pathname.endsWith('/tools') && request.method() === 'GET') {
      await json(route, { success: true, data: dbTools })
      return
    }

    if (pathname.endsWith('/runtime/skills') && request.method() === 'GET') {
      await json(route, {
        success: true,
        data: {
          available: true,
          tools: runtimeTools,
          skills: [],
          source: 'http://localhost:8901',
        },
      })
      return
    }

    await route.continue()
  })
}

test.describe('No-Auth Shell', () => {
  test('dashboard should not redirect to login and should not render user menu block', async ({ page }) => {
    await setupCommonMocks(page)

    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.getByRole('heading', { name: 'Semibot 新版工作台' })).toBeVisible()
    await expect(page.getByTestId('user-menu')).toHaveCount(0)
  })

  test('navbar should contain tools entry and open tools page', async ({ page }) => {
    await setupCommonMocks(page, {
      dbTools: [
        {
          id: 'tool_1',
          name: 'pdf',
          type: 'builtin',
          description: 'PDF generation',
          isBuiltin: true,
          isActive: true,
        },
      ],
      runtimeTools: ['code_executor', 'pdf', 'xlsx'],
    })

    await page.goto('/dashboard')
    await expect(page.locator('a[href="/tools"]').first()).toBeVisible()

    await page.goto('/tools')
    await expect(page).toHaveURL(/\/tools$/)
    await expect(page.getByRole('heading', { name: 'Tools 能力中心' })).toBeVisible()
    await expect(page.getByText('code_executor')).toBeVisible()
  })
})
