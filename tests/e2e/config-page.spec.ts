import { test, expect, type Page, type Route } from '@playwright/test'

type LlmConfigPayload = {
  defaultModel: string
  fallbackModel: string
  providers: {
    openai: { apiKeyConfigured: boolean; apiKeyPreview: string | null; baseUrl: string }
    anthropic: { apiKeyConfigured: boolean; apiKeyPreview: string | null; baseUrl: string }
    google: { apiKeyConfigured: boolean; apiKeyPreview: string | null; baseUrl: string }
    custom: { apiKeyConfigured: boolean; apiKeyPreview: string | null; baseUrl: string }
  }
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function setupConfigPageMocks(page: Page, onLlmConfigPut?: (payload: any) => void) {
  await page.route('**/api/v1/sessions**', async (route) => {
    await json(route, {
      success: true,
      data: [],
      meta: { total: 0, page: 1, limit: 10, totalPages: 0 },
    })
  })

  const llmConfig: LlmConfigPayload = {
    defaultModel: 'gpt-4o',
    fallbackModel: 'gpt-3.5-turbo',
    providers: {
      openai: {
        apiKeyConfigured: true,
        apiKeyPreview: 'sk-a***1234',
        baseUrl: 'https://api.openai.com/v1',
      },
      anthropic: {
        apiKeyConfigured: false,
        apiKeyPreview: null,
        baseUrl: 'https://api.anthropic.com/v1',
      },
      google: {
        apiKeyConfigured: false,
        apiKeyPreview: null,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      },
      custom: {
        apiKeyConfigured: false,
        apiKeyPreview: null,
        baseUrl: 'https://custom-llm.example.com/v1',
      },
    },
  }

  await page.route('**/api/v1/llm-providers/status', async (route) => {
    await json(route, {
      success: true,
      data: [
        { name: 'openai', displayName: 'OpenAI', available: true, models: ['gpt-4o', 'gpt-4.1-mini'] },
        { name: 'anthropic', displayName: 'Anthropic', available: false, models: [] },
        { name: 'google', displayName: 'Google AI', available: false, models: [] },
        { name: 'custom', displayName: '自定义模型', available: true, models: ['qwen-plus'] },
      ],
    })
  })

  await page.route('**/api/v1/llm-providers/config', async (route, request) => {
    if (request.method() === 'GET') {
      await json(route, { success: true, data: llmConfig })
      return
    }

    if (request.method() === 'PUT') {
      const payload = request.postDataJSON()
      onLlmConfigPut?.(payload)

      if (payload?.defaultModel !== undefined) llmConfig.defaultModel = payload.defaultModel
      if (payload?.fallbackModel !== undefined) llmConfig.fallbackModel = payload.fallbackModel
      if (payload?.providers) {
        llmConfig.providers = { ...llmConfig.providers, ...payload.providers }
      }

      await json(route, {
        success: true,
        data: llmConfig,
        meta: { updatedKeys: ['DEFAULT_LLM_MODEL'] },
      })
      return
    }

    await route.continue()
  })

  await page.route('**/api/v1/tools**', async (route, request) => {
    if (request.method() === 'GET') {
      await json(route, { success: true, data: [] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/tools/by-name/**', async (route, request) => {
    if (request.method() === 'PUT') {
      const name = decodeURIComponent(request.url().split('/by-name/')[1] || '')
      await json(route, {
        success: true,
        data: {
          id: `builtin:${name}`,
          name,
          type: 'builtin',
          isBuiltin: true,
          isActive: true,
          config: request.postDataJSON()?.config || {},
        },
      })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/runtime/skills**', async (route) => {
    await json(route, {
      success: true,
      data: {
        available: true,
        tools: ['search', 'file_io', 'code_executor', 'browser_automation', 'xlsx', 'pdf'],
        skills: [],
        source: 'http://localhost:8901',
      },
    })
  })

  await page.route('**/api/v1/api-keys**', async (route, request) => {
    if (request.method() === 'GET') {
      await json(route, { success: true, data: [] })
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/webhooks**', async (route, request) => {
    if (request.method() === 'GET') {
      await json(route, { success: true, data: [] })
      return
    }
    await route.continue()
  })
}

test.describe('Config Page', () => {
  test('should render editable LLM config and hide organization section', async ({ page }) => {
    await setupConfigPageMocks(page)
    await page.goto('/config')

    await expect(page.getByRole('heading', { name: '配置管理' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '模型路由默认值' })).toBeVisible()

    await expect(page.getByPlaceholder('DEFAULT_LLM_MODEL')).toHaveValue('gpt-4o')
    await expect(page.getByPlaceholder('FALLBACK_LLM_MODEL')).toHaveValue('gpt-3.5-turbo')
    await expect(page.getByText('组织配置')).toHaveCount(0)

    await page.getByRole('button', { name: 'Tools' }).click()
    await expect(page.getByText('工具配置（仅启停与参数）')).toBeVisible()
    await expect(page.getByText('search')).toBeVisible()
    await expect(page.getByText('code_executor')).toBeVisible()
    await expect(page.getByText('file_io')).toBeVisible()
    await expect(page.getByText('browser_automation')).toBeVisible()
    await expect(page.getByText('pdf')).toHaveCount(0)
    await expect(page.getByText('xlsx')).toHaveCount(0)
  })

  test('should save default/fallback model routing', async ({ page }) => {
    let capturedPayload: any = null
    await setupConfigPageMocks(page, (payload) => {
      capturedPayload = payload
    })
    await page.goto('/config')

    await page.getByPlaceholder('DEFAULT_LLM_MODEL').fill('gpt-4.1')
    await page.getByPlaceholder('FALLBACK_LLM_MODEL').fill('gpt-4.1-mini')
    await page.getByRole('button', { name: '保存模型路由' }).click()

    await expect.poll(() => capturedPayload).not.toBeNull()
    expect(capturedPayload).toMatchObject({
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1-mini',
    })
  })

  test('should save provider config from modal', async ({ page }) => {
    const payloads: any[] = []
    await setupConfigPageMocks(page, (payload) => payloads.push(payload))
    await page.goto('/config')

    await page.getByRole('button', { name: '编辑' }).first().click()

    await expect(page.getByRole('dialog', { name: '编辑 LLM Provider' })).toBeVisible()
    await page.getByPlaceholder('新 API Key（留空则不修改）').fill('sk-test-new-key')
    await page.getByPlaceholder('API Endpoint').fill('https://api.openai.com/v1')
    await page.getByRole('dialog', { name: '编辑 LLM Provider' }).getByRole('button', { name: '保存' }).click()

    await expect.poll(() => payloads.length).toBeGreaterThan(0)
    expect(payloads[payloads.length - 1]).toMatchObject({
      providers: {
        openai: {
          apiKey: 'sk-test-new-key',
          baseUrl: 'https://api.openai.com/v1',
          clearApiKey: false,
        },
      },
    })
  })

  test('should save browser automation tool config', async ({ page }) => {
    const toolPayloads: any[] = []
    await setupConfigPageMocks(page)
    await page.route('**/api/v1/tools/by-name/browser_automation', async (route, request) => {
      if (request.method() === 'PUT') {
        toolPayloads.push(request.postDataJSON())
      }
      await json(route, {
        success: true,
        data: {
          id: 'builtin:browser_automation',
          name: 'browser_automation',
          type: 'builtin',
          isBuiltin: true,
          isActive: true,
          config: request.postDataJSON()?.config || {},
        },
      })
    })

    await page.goto('/config')
    await page.getByRole('button', { name: 'Tools' }).click()

    const browserCard = page.locator('div').filter({ hasText: /^browser_automation/ }).first()
    await browserCard.getByRole('button', { name: '配置' }).click()

    await expect(page.getByRole('dialog', { name: '工具配置' })).toBeVisible()
    await page.getByLabel('使用无头模式运行浏览器').uncheck()
    await page.getByPlaceholder('allowedDomains（可选，逗号分隔，如 example.com,news.ycombinator.com）').fill(
      'example.com,news.ycombinator.com'
    )
    await page.getByPlaceholder('blockedDomains（可选，逗号分隔）').fill('localhost,127.0.0.1')
    await page.getByPlaceholder('maxTextLength（可选，100-500000）').fill('25000')
    await page
      .getByRole('dialog', { name: '工具配置' })
      .getByRole('button', { name: '保存' })
      .click()

    await expect.poll(() => toolPayloads.length).toBeGreaterThan(0)
    expect(toolPayloads[0]).toMatchObject({
      config: {
        headless: false,
        allowedDomains: ['example.com', 'news.ycombinator.com'],
        blockedDomains: ['localhost', '127.0.0.1'],
        maxTextLength: 25000,
      },
    })
  })
})
