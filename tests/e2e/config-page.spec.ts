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

  const gatewayState = {
    'gw-feishu': {
      id: 'gw-feishu',
      instanceKey: 'feishu-default',
      provider: 'feishu',
      displayName: 'Feishu',
      isDefault: true,
      isActive: true,
      mode: 'webhook',
      riskLevel: 'high',
      requiresApproval: false,
      status: 'ready',
      config: {
        verifyToken: '***',
        webhookUrl: 'https://open.feishu.cn/hook/demo',
        notifyEventTypes: ['approval.requested'],
      },
      updatedAt: '2026-02-27T10:00:00.000Z',
    },
    'gw-telegram': {
      id: 'gw-telegram',
      instanceKey: 'telegram-default',
      provider: 'telegram',
      displayName: 'Telegram',
      isDefault: true,
      isActive: false,
      mode: 'webhook',
      riskLevel: 'high',
      requiresApproval: false,
      status: 'not_configured',
      config: {
        botToken: null,
        defaultChatId: null,
        allowedChatIds: [],
      },
      updatedAt: '2026-02-27T10:00:00.000Z',
    },
  } as Record<string, any>

  await page.route('**/api/v1/gateways/instances**', async (route, request) => {
    const method = request.method()
    if (method === 'GET') {
      await json(route, { success: true, data: Object.values(gatewayState) })
      return
    }
    if (method === 'POST') {
      const payload = request.postDataJSON() as any
      const id = `gw-${Date.now()}`
      gatewayState[id] = {
        id,
        instanceKey: payload?.instanceKey || `instance-${Date.now()}`,
        provider: payload?.provider || 'telegram',
        displayName: payload?.displayName || 'Gateway',
        isDefault: payload?.isDefault === true,
        isActive: payload?.isActive === true,
        mode: payload?.mode || 'webhook',
        riskLevel: payload?.riskLevel || 'high',
        requiresApproval: payload?.requiresApproval === true,
        status: 'ready',
        config: payload?.config || {},
        addressingPolicy: payload?.addressingPolicy,
        proactivePolicy: payload?.proactivePolicy,
        contextPolicy: payload?.contextPolicy,
        updatedAt: '2026-02-27T10:00:00.000Z',
      }
      await json(route, { success: true, data: gatewayState[id] }, 201)
      return
    }
    await route.continue()
  })

  await page.route('**/api/v1/gateways/instances/*', async (route, request) => {
    const method = request.method()
    const url = request.url()
    const tail = url.split('/api/v1/gateways/instances/')[1] || ''
    const [instanceId, action] = tail.split('/')
    if (!instanceId || !gatewayState[instanceId]) {
      await route.continue()
      return
    }

    if (method === 'PUT') {
      const payload = request.postDataJSON() as any
      const existing = gatewayState[instanceId]
      gatewayState[instanceId] = {
        ...existing,
        ...(payload.displayName ? { displayName: payload.displayName } : {}),
        ...(payload.isDefault !== undefined ? { isDefault: payload.isDefault } : {}),
        ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
        ...(payload.config ? { config: { ...existing.config, ...payload.config } } : {}),
        ...(payload.addressingPolicy ? { addressingPolicy: payload.addressingPolicy } : {}),
        ...(payload.proactivePolicy ? { proactivePolicy: payload.proactivePolicy } : {}),
        ...(payload.contextPolicy ? { contextPolicy: payload.contextPolicy } : {}),
      }
      await json(route, { success: true, data: gatewayState[instanceId] })
      return
    }

    if (method === 'DELETE') {
      delete gatewayState[instanceId]
      await json(route, { success: true, data: { deleted: true } })
      return
    }

    if (method === 'POST' && action === 'test') {
      await json(route, { success: true, data: { sent: true } })
      return
    }

    await route.continue()
  })

  await page.route('**/api/v1/gateways/instances/batch', async (route, request) => {
    if (request.method() !== 'POST') {
      await route.continue()
      return
    }
    const payload = request.postDataJSON() as {
      action?: 'enable' | 'disable' | 'delete'
      instanceIds?: string[]
      ignoreMissing?: boolean
    }
    const action = payload?.action || 'enable'
    const requested = Array.from(new Set((payload?.instanceIds || []).filter(Boolean)))
    const changed: string[] = []
    const unchanged: string[] = []
    const blocked: Array<{ instanceId: string; reason: string }> = []
    const missing: string[] = []

    for (const id of requested) {
      const item = gatewayState[id]
      if (!item) {
        missing.push(id)
        continue
      }
      if (action === 'enable') {
        if (item.isActive) unchanged.push(id)
        else {
          item.isActive = true
          changed.push(id)
        }
        continue
      }
      if (action === 'disable') {
        if (!item.isActive) unchanged.push(id)
        else {
          item.isActive = false
          changed.push(id)
        }
        continue
      }
      if (item.isDefault) {
        blocked.push({ instanceId: id, reason: 'default_instance' })
      } else {
        delete gatewayState[id]
        changed.push(id)
      }
    }

    await json(route, {
      success: true,
      data: {
        action,
        requested,
        targets: requested.filter((id) => gatewayState[id] || changed.includes(id)),
        changed,
        unchanged,
        blocked,
        missing,
        failed: [],
      },
    })
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
    await page.setViewportSize({ width: 1440, height: 1600 })
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
    const saveBtn = page.getByRole('dialog', { name: '工具配置' }).getByRole('button', { name: '保存' })
    await saveBtn.scrollIntoViewIfNeeded()
    await saveBtn.click({ force: true })

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

  test('should edit and test telegram gateway config', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1800 })
    const gatewayPutPayloads: any[] = []
    const gatewayTestCalls: string[] = []
    let telegramState: any = {
      id: 'gw-telegram',
      instanceKey: 'telegram-default',
      provider: 'telegram',
      displayName: 'Telegram',
      isDefault: true,
      isActive: false,
      mode: 'webhook',
      riskLevel: 'high',
      requiresApproval: false,
      status: 'not_configured',
      config: {
        botToken: null,
        defaultChatId: null,
        allowedChatIds: [],
        notifyEventTypes: [],
      },
      updatedAt: '2026-02-27T10:00:00.000Z',
    }

    await setupConfigPageMocks(page)
    await page.route('**/api/v1/gateways/instances/gw-telegram', async (route, request) => {
      if (request.method() === 'PUT') {
        const payload = request.postDataJSON()
        gatewayPutPayloads.push(payload)
        telegramState = {
          ...telegramState,
          ...(payload?.displayName ? { displayName: payload.displayName } : {}),
          ...(payload?.isActive !== undefined ? { isActive: payload.isActive } : {}),
          ...(payload?.config ? { config: { ...telegramState.config, ...payload.config } } : {}),
          ...(payload?.addressingPolicy ? { addressingPolicy: payload.addressingPolicy } : {}),
          ...(payload?.proactivePolicy ? { proactivePolicy: payload.proactivePolicy } : {}),
          ...(payload?.contextPolicy ? { contextPolicy: payload.contextPolicy } : {}),
          status: 'ready',
        }
      }
      await json(route, { success: true, data: telegramState })
    })
    await page.route('**/api/v1/gateways/instances/gw-telegram/test', async (route) => {
      gatewayTestCalls.push(route.request().url())
      await json(route, { success: true, data: { sent: true } })
    })

    await page.goto('/config')
    await page.getByRole('button', { name: 'Gateways' }).click()
    await expect(page.getByRole('heading', { name: 'Gateways' })).toBeVisible()

    const tgCard = page.locator('div').filter({ hasText: /^Telegram/ }).first()
    await tgCard.getByRole('button', { name: /^编辑$/ }).click()
    await expect(page.getByRole('dialog', { name: 'Gateway 配置' })).toBeVisible()
    await page.getByPlaceholder('显示名称').fill('Telegram Ops')
    await page.getByPlaceholder('Agent ID（默认 semibot）').fill('fund-analyst')
    await page.getByPlaceholder('Telegram Bot Token（留空可清空）').fill('tg_token_123')
    await page.getByPlaceholder('默认 Chat ID（可选）').fill('-10012345')
    await page.getByPlaceholder('allowedChatIds（可选，逗号分隔）').fill('-10012345,-100999')
    await page.getByTestId('gateway-chat-binding-add').click()
    await page.getByTestId('gateway-chat-binding-chat-0').fill('-10012345')
    await page.getByTestId('gateway-chat-binding-agent-0').fill('fund-analyst')
    await page.getByTestId('gateway-chat-binding-add').click()
    await page.getByTestId('gateway-chat-binding-chat-1').fill('-100999')
    await page.getByTestId('gateway-chat-binding-agent-1').fill('risk-officer')
    await page.getByPlaceholder('notifyEventTypes（可选，逗号分隔）').fill('approval.requested,task.completed')
    const gatewayDialog = page.getByRole('dialog', { name: 'Gateway 配置' })
    await gatewayDialog.locator('select').nth(0).selectOption('all_messages')
    await gatewayDialog.getByLabel('将“回复 Bot 消息”视为命中').uncheck()
    await gatewayDialog.getByLabel('未命中时仍执行（谨慎开启）').check()
    await page
      .getByPlaceholder('commandPrefixes（可选，逗号分隔，如 /ask,/run,/approve,/reject）')
      .fill('/ask,/run')
    await page.getByPlaceholder('sessionContinuationWindowSec（正整数秒）').fill('600')
    await gatewayDialog.locator('select').nth(1).selectOption('risk_based')
    await gatewayDialog.locator('select').nth(2).selectOption('high')
    await page.getByPlaceholder('ttlDays（上下文保留天数）').fill('14')
    await page.getByPlaceholder('maxRecentMessages（最近消息条数上限）').fill('120')
    await page.getByPlaceholder('summarizeEveryNMessages（每 N 条触发摘要）').fill('30')
    const gatewaySaveBtn = page.getByRole('dialog', { name: 'Gateway 配置' }).getByRole('button', { name: '保存' })
    await gatewaySaveBtn.scrollIntoViewIfNeeded()
    await gatewaySaveBtn.click({ force: true })

    await expect.poll(() => gatewayPutPayloads.length).toBeGreaterThan(0)
    expect(gatewayPutPayloads[0]).toMatchObject({
      displayName: 'Telegram Ops',
      config: {
        agentId: 'fund-analyst',
        botToken: 'tg_token_123',
        defaultChatId: '-10012345',
        allowedChatIds: ['-10012345', '-100999'],
        chatBindings: [
          { chatId: '-10012345', agentId: 'fund-analyst' },
          { chatId: '-100999', agentId: 'risk-officer' },
        ],
        notifyEventTypes: ['approval.requested', 'task.completed'],
      },
      addressingPolicy: {
        mode: 'all_messages',
        allowReplyToBot: false,
        executeOnUnaddressed: true,
        commandPrefixes: ['/ask', '/run'],
        sessionContinuationWindowSec: 600,
      },
      proactivePolicy: {
        mode: 'risk_based',
        minRiskToNotify: 'high',
      },
      contextPolicy: {
        ttlDays: 14,
        maxRecentMessages: 120,
        summarizeEveryNMessages: 30,
      },
    })

    await tgCard.getByRole('button', { name: '测试' }).click()
    await expect.poll(() => gatewayTestCalls.length).toBeGreaterThan(0)
  })

  test('should batch enable/disable selected gateway instances', async ({ page }) => {
    const batchCalls: Array<{ url: string; payload: any }> = []
    const testCalls: Array<{ url: string; payload: any }> = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      if (request.url().includes('/api/v1/gateways/instances/batch')) {
        batchCalls.push({
          url: request.url(),
          payload: request.postDataJSON(),
        })
        return
      }
      if (request.url().includes('/api/v1/gateways/instances/') && request.url().endsWith('/test')) {
        testCalls.push({
          url: request.url(),
          payload: request.postDataJSON(),
        })
      }
    })

    await setupConfigPageMocks(page)
    await page.goto('/config')
    await page.getByRole('button', { name: 'Gateways' }).click()

    await page.getByTestId('gateway-select-gw-telegram').check()
    await page.getByTestId('gateways-batch-enable').click()
    await expect.poll(() => batchCalls.length).toBeGreaterThanOrEqual(1)
    expect(batchCalls[0].url).toContain('/api/v1/gateways/instances/batch')
    expect(batchCalls[0].payload).toMatchObject({
      action: 'enable',
      instanceIds: ['gw-telegram'],
    })

    await page.getByTestId('gateways-select-all').check()
    await page.getByTestId('gateways-batch-disable').click()

    await expect.poll(() => batchCalls.length).toBeGreaterThanOrEqual(2)
    expect(batchCalls[1].payload).toMatchObject({
      action: 'disable',
      instanceIds: ['gw-feishu', 'gw-telegram'],
    })

    await page.getByTestId('gateways-batch-test').click()
    await expect.poll(() => testCalls.length).toBeGreaterThanOrEqual(2)
    const testUrls = testCalls.map((item) => item.url)
    expect(testUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/v1/gateways/instances/gw-feishu/test'),
        expect.stringContaining('/api/v1/gateways/instances/gw-telegram/test'),
      ])
    )
  })

  test('should batch action only within filtered provider scope', async ({ page }) => {
    const batchCalls: Array<{ payload: any }> = []
    page.on('request', (request) => {
      if (request.method() !== 'POST') return
      if (!request.url().includes('/api/v1/gateways/instances/batch')) return
      batchCalls.push({ payload: request.postDataJSON() })
    })

    await setupConfigPageMocks(page)
    await page.goto('/config')
    await page.getByRole('button', { name: 'Gateways' }).click()

    await page.getByTestId('gateways-filter-telegram').click()
    await page.getByTestId('gateways-select-all').check()
    await page.getByTestId('gateways-batch-disable').click()

    await expect.poll(() => batchCalls.length).toBeGreaterThanOrEqual(1)
    expect(batchCalls[0].payload).toMatchObject({
      action: 'disable',
      instanceIds: ['gw-telegram'],
    })
  })

  test('should quick edit gateway chat bindings from list card', async ({ page }) => {
    const putCalls: Array<{ url: string; payload: any }> = []
    page.on('request', (request) => {
      if (request.method() !== 'PUT') return
      if (!request.url().includes('/api/v1/gateways/instances/gw-telegram')) return
      putCalls.push({ url: request.url(), payload: request.postDataJSON() })
    })

    await setupConfigPageMocks(page)
    await page.goto('/config')
    await page.getByRole('button', { name: 'Gateways' }).click()

    await page.getByTestId('gateway-quick-edit-gw-telegram').click()
    await page.getByTestId('gateway-quick-add-gw-telegram').click()
    await page.getByTestId('gateway-quick-chat-gw-telegram-0').fill('-100777')
    await page.getByTestId('gateway-quick-agent-gw-telegram-0').fill('ops-agent')
    await page.getByTestId('gateway-quick-save-gw-telegram').click()

    await expect.poll(() => putCalls.length).toBeGreaterThanOrEqual(1)
    expect(putCalls[0].payload).toMatchObject({
      config: {
        chatBindings: [{ chatId: '-100777', agentId: 'ops-agent' }],
      },
    })
  })

  test('should import and normalize gateway chat bindings in quick edit', async ({ page }) => {
    const putCalls: Array<{ payload: any }> = []
    const dialogMessages: string[] = []
    page.on('request', (request) => {
      if (request.method() !== 'PUT') return
      if (!request.url().includes('/api/v1/gateways/instances/gw-telegram')) return
      putCalls.push({ payload: request.postDataJSON() })
    })
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message())
      await dialog.accept()
    })

    await setupConfigPageMocks(page)
    await page.goto('/config')
    await page.getByRole('button', { name: 'Gateways' }).click()

    await page.getByTestId('gateway-quick-edit-gw-telegram').click()
    await page
      .getByTestId('gateway-quick-import-gw-telegram')
      .fill('-1001=agent-a\n-1001=agent-b\n-1002')
    await page.getByTestId('gateway-quick-import-apply-gw-telegram').click()
    await page.getByTestId('gateway-quick-save-gw-telegram').click()

    await expect.poll(() => putCalls.length).toBeGreaterThanOrEqual(1)
    expect(dialogMessages.some((msg) => msg.includes('重复') || msg.includes('duplicate'))).toBeTruthy()
    expect(putCalls[0].payload).toMatchObject({
      config: {
        chatBindings: [
          { chatId: '-1001', agentId: 'agent-b' },
          { chatId: '-1002', agentId: 'semibot' },
        ],
      },
    })
  })
})
