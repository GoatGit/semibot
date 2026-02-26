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

async function openToolsPage(page: Page) {
  const toolsEntry = page.locator('a[href="/tools"]').first()
  await expect(toolsEntry).toBeVisible()

  try {
    await toolsEntry.click()
    await expect(page).toHaveURL(/\/tools$/, { timeout: 5000 })
    return
  } catch {
    // fallback to direct navigation
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto('/tools', { waitUntil: 'domcontentloaded', timeout: 20000 })
      await expect(page).toHaveURL(/\/tools$/, { timeout: 10000 })
      return
    } catch {
      if (attempt === 3) throw new Error('Failed to open /tools after 3 attempts')
      await page.waitForTimeout(1200)
    }
  }
}

async function setupCommonMocks(page: Page, options: NoAuthMockOptions = {}) {
  const runtimeTools = options.runtimeTools ?? []
  const dbTools = options.dbTools ?? []

  await page.route('**/api/v1/**', async (route, request) => {
    const { pathname } = new URL(request.url())
    const matches = (segment: string) => pathname.includes(segment)

    if (matches('/api/v1/sessions') && request.method() === 'GET' && !matches('/messages')) {
      await json(route, {
        success: true,
        data: [],
        meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
      })
      return
    }

    if (matches('/api/v1/users/preferences') && request.method() === 'GET') {
      await json(route, {
        success: true,
        data: { theme: 'light', language: 'zh-CN' },
      })
      return
    }

    if (matches('/api/v1/tools') && request.method() === 'GET') {
      await json(route, { success: true, data: dbTools })
      return
    }

    if (matches('/api/v1/agents') && request.method() === 'GET') {
      await json(route, {
        success: true,
        data: [],
        meta: { total: 0, page: 1, limit: 100, totalPages: 0 },
      })
      return
    }

    if (matches('/api/v1/runtime/skills') && request.method() === 'GET') {
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

    await json(route, { success: true, data: null })
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
    await openToolsPage(page)
    await expect(page.getByRole('heading', { name: 'Tools 能力中心' })).toBeVisible()
    await expect(page.getByText('code_executor')).toBeVisible()
  })
})
