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

  await page.route('**/api/v1/runtime/skills**', async (route) => {
    await json(route, {
      success: true,
      data: {
        available: true,
        tools: ['code_executor', 'pdf', 'xlsx'],
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
    await expect(page.getByText('Runtime 内置工具')).toBeVisible()
    await expect(page.getByText('code_executor')).toBeVisible()
    await expect(page.getByText('pdf')).toBeVisible()
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
})
