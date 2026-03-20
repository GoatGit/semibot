import { test, expect, type Route, type Page } from '@playwright/test'

/**
 * Studio (智能体工作室) E2E Tests
 *
 * 覆盖流程：
 * 1. Studio 列表页 - 加载、创建
 * 2. Canvas 编辑器 - ReactFlow 渲染、添加 Agent 节点
 * 3. 保存 - 成功 toast
 * 4. 运行 - 填写输入、启动、跳转到运行详情
 * 5. 运行历史 - 列表渲染
 * 6. 运行详情 - 状态展示、节点结果
 *
 * 运行方式（需要 RUN_LIVE_E2E=1 或 mock 模式）：
 *   cd tests/e2e && npx playwright test studio.spec.ts --reporter=list
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STUDIO_ID = 'studio-test-001'
const RUN_ID = 'run-test-001'

const MOCK_STUDIO = {
  id: STUDIO_ID,
  name: '测试工作室',
  description: '用于 E2E 测试',
  nodes: [],
  edges: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const MOCK_STUDIO_WITH_NODE = {
  ...MOCK_STUDIO,
  nodes: [
    {
      id: 'node_1',
      agentId: 'agent-001',
      position: { x: 200, y: 150 },
    },
  ],
}

const MOCK_AGENTS = [
  {
    id: 'agent-001',
    name: '测试 Agent',
    description: '用于测试的智能体',
    isActive: true,
    config: {},
  },
  {
    id: 'agent-002',
    name: '非活跃 Agent',
    description: '已停用',
    isActive: false,
    config: {},
  },
]

const MOCK_RUN: {
  id: string
  studioId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  inputs: Record<string, unknown>
  nodeResults: Record<string, { status: 'pending' | 'running' | 'completed' | 'failed'; output?: { text: string; files: { url: string; filename: string }[] }; error?: string; sessionId?: string }>
  createdAt: string
  completedAt: string | null
  error: string | null
} = {
  id: RUN_ID,
  studioId: STUDIO_ID,
  status: 'completed',
  inputs: {},
  nodeResults: {
    node_1: {
      status: 'completed',
      output: { text: '节点执行完成', files: [] },
      sessionId: 'sess-abc123',
    },
  },
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  error: null,
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

async function respondJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

/**
 * 注册 Studio 相关 API mock，覆盖所有 /api/v1/studios/* 路由
 */
async function setupStudioMocks(page: Page, overrides: {
  studios?: unknown[]
  studio?: unknown
  agents?: unknown[]
  runs?: unknown[]
  run?: unknown
  createRunId?: string
} = {}) {
  const studios = overrides.studios ?? [MOCK_STUDIO]
  const studio = overrides.studio ?? MOCK_STUDIO
  const agents = overrides.agents ?? MOCK_AGENTS
  const runs = overrides.runs ?? [MOCK_RUN]
  const run = overrides.run ?? MOCK_RUN
  const createRunId = overrides.createRunId ?? RUN_ID

  // 通用 preferences mock（防止 404 噪音）
  await page.route('**/api/v1/users/preferences', async (route) => {
    await respondJson(route, { success: true, data: { theme: 'light', language: 'zh-CN' } })
  })

  await page.route('**/api/v1/**', async (route, request) => {
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()

    // GET /studios - 列表
    if (path.endsWith('/studios') && method === 'GET') {
      await respondJson(route, { success: true, data: studios })
      return
    }

    // POST /studios - 创建
    if (path.endsWith('/studios') && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}')
      await respondJson(route, {
        success: true,
        data: { ...MOCK_STUDIO, id: 'studio-new-001', name: body.name ?? '新工作室' },
      }, 201)
      return
    }

    // GET /studios/:id - 详情
    if (path.match(/\/studios\/[^/]+$/) && method === 'GET') {
      await respondJson(route, { success: true, data: studio })
      return
    }

    // PUT /studios/:id - 保存
    if (path.match(/\/studios\/[^/]+$/) && method === 'PUT') {
      await respondJson(route, { success: true, data: studio })
      return
    }

    // DELETE /studios/:id - 删除
    if (path.match(/\/studios\/[^/]+$/) && method === 'DELETE') {
      await respondJson(route, { success: true, data: null })
      return
    }

    // GET /studios/:id/runs - 运行列表
    if (path.match(/\/studios\/[^/]+\/runs$/) && method === 'GET') {
      await respondJson(route, { success: true, data: runs })
      return
    }

    // POST /studios/:id/runs - 启动运行
    if (path.match(/\/studios\/[^/]+\/runs$/) && method === 'POST') {
      await respondJson(route, { success: true, data: { runId: createRunId } }, 201)
      return
    }

    // GET /studios/:id/runs/:runId - 运行详情
    if (path.match(/\/studios\/[^/]+\/runs\/[^/]+$/) && method === 'GET') {
      await respondJson(route, { success: true, data: run })
      return
    }

    // GET /agents - Agent 列表
    if (path.endsWith('/agents') && method === 'GET') {
      await respondJson(route, { success: true, data: agents })
      return
    }

    // 其他请求放行或返回空成功
    await respondJson(route, { success: true, data: null })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Studio 智能体工作室', () => {
  // -------------------------------------------------------------------------
  // 1. Studio 列表页
  // -------------------------------------------------------------------------
  test.describe('列表页', () => {
    test('加载并展示工作室列表', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto('/studio')

      // 页面标题
      await expect(page.getByRole('heading', { name: '智能体工作室' })).toBeVisible()

      // 创建按钮
      await expect(page.getByRole('button', { name: /创建工作室/ })).toBeVisible()

      // 工作室卡片
      await expect(page.getByText('测试工作室')).toBeVisible()
    })

    test('空列表时展示空状态', async ({ page }) => {
      await setupStudioMocks(page, { studios: [] })
      await page.goto('/studio')

      await expect(page.getByText(/暂无智能体工作室/)).toBeVisible()
    })

    test('点击创建按钮打开创建弹窗', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto('/studio')

      await page.getByRole('button', { name: /创建工作室/ }).click()

      // 弹窗出现
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByPlaceholder(/输入工作室名称/)).toBeVisible()
    })

    test('填写名称后创建工作室并跳转到编辑器', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto('/studio')

      await page.getByRole('button', { name: /创建工作室/ }).click()
      await page.getByPlaceholder(/输入工作室名称/).fill('我的新工作室')

      // 等待 POST /studios 请求完成后跳转
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes('/studios') && res.request().method() === 'POST'),
        page.getByRole('button', { name: /^创建$/ }).click(),
      ])

      expect(response.ok()).toBeTruthy()
      await expect(page).toHaveURL(/\/studio\/studio-new-001/)
    })

    test('点击删除按钮弹出确认弹窗', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto('/studio')

      // 等待卡片渲染
      await expect(page.getByText('测试工作室')).toBeVisible()

      // 点击删除图标（Trash2）
      const deleteBtn = page.locator('button[title]').filter({ hasText: '' }).last()
      // 用 title 属性定位更可靠
      await page.locator('button').filter({ has: page.locator('svg') }).last().click()

      // 确认弹窗
      await expect(page.getByText(/确认删除/)).toBeVisible()
    })
  })

  // -------------------------------------------------------------------------
  // 2. Canvas 编辑器
  // -------------------------------------------------------------------------
  test.describe('Canvas 编辑器', () => {
    test('加载 Canvas 页面并渲染 ReactFlow', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      // 工具栏
      await expect(page.getByText('测试工作室')).toBeVisible()
      await expect(page.getByRole('button', { name: /添加 Agent/ })).toBeVisible()
      // 精确匹配"运行"按钮，避免与"运行历史"冲突
      await expect(page.getByRole('button', { name: '运行', exact: true })).toBeVisible()

      // ReactFlow 容器
      await expect(page.locator('.react-flow')).toBeVisible()
    })

    test('有节点时 Canvas 渲染 Agent 节点', async ({ page }) => {
      await setupStudioMocks(page, { studio: MOCK_STUDIO_WITH_NODE })
      await page.goto(`/studio/${STUDIO_ID}`)

      // ReactFlow 节点容器
      await expect(page.locator('.react-flow__nodes')).toBeVisible()
      // 至少有一个节点
      await expect(page.locator('.react-flow__node')).toHaveCount(1)
    })

    test('点击"添加 Agent"打开 Agent 选择弹窗', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      await page.getByRole('button', { name: /添加 Agent/ }).click()

      // 弹窗出现，只显示 isActive=true 的 Agent
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText('测试 Agent')).toBeVisible()
      // 非活跃 Agent 不应出现
      await expect(page.getByText('非活跃 Agent')).not.toBeVisible()
    })

    test('选择 Agent 后节点添加到画布', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      await page.getByRole('button', { name: /添加 Agent/ }).click()
      await expect(page.getByText('测试 Agent')).toBeVisible()

      // 点击 Agent 选项
      await page.getByText('测试 Agent').click()

      // 弹窗关闭
      await expect(page.getByRole('dialog')).not.toBeVisible()

      // 节点出现在画布
      await expect(page.locator('.react-flow__node')).toHaveCount(1)
    })

    test('点击保存按钮触发 PUT 请求', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      // 等待页面加载完成
      await expect(page.locator('.react-flow')).toBeVisible()

      const [response] = await Promise.all([
        page.waitForResponse((res) =>
          res.url().includes(`/studios/${STUDIO_ID}`) && res.request().method() === 'PUT'
        ),
        // 保存按钮有 title="保存"
        page.getByRole('button', { name: '保存', exact: true }).click(),
      ])

      expect(response.ok()).toBeTruthy()
    })

    test('点击运行按钮打开运行弹窗', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      await page.getByRole('button', { name: '运行', exact: true }).click()

      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByPlaceholder(/\{"key": "value"\}/)).toBeVisible()
    })

    test('启动运行后跳转到运行详情页', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      await page.getByRole('button', { name: '运行', exact: true }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const [response] = await Promise.all([
        page.waitForResponse((res) =>
          res.url().includes(`/studios/${STUDIO_ID}/runs`) && res.request().method() === 'POST'
        ),
        page.getByRole('dialog').getByRole('button', { name: /运行/ }).click(),
      ])

      expect(response.ok()).toBeTruthy()
      await expect(page).toHaveURL(new RegExp(`/studio/${STUDIO_ID}/runs/${RUN_ID}`))
    })

    test('点击运行历史按钮跳转到 runs 页', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      await page.getByRole('button', { name: '运行历史', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/studio/${STUDIO_ID}/runs$`))
    })

    test('点击返回按钮跳转到 Studio 列表', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}`)

      // 等待工具栏渲染，返回按钮是工具栏第一个按钮（ArrowLeft，无文字）
      await expect(page.getByText('测试工作室')).toBeVisible()
      // 工具栏容器内的第一个按钮
      const toolbar = page.locator('.border-b.border-border.bg-card')
      await toolbar.getByRole('button').first().click()
      await expect(page).toHaveURL(/\/studio$/)
    })
  })

  // -------------------------------------------------------------------------
  // 3. 运行历史页
  // -------------------------------------------------------------------------
  test.describe('运行历史页', () => {
    test('加载并展示运行列表', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs`)

      // 页面标题区域
      await expect(page.getByText('测试工作室')).toBeVisible()
      await expect(page.getByText(/运行历史/)).toBeVisible()

      // 运行记录（历史记录区域）
      await expect(page.getByText(/历史记录/)).toBeVisible()
      // 运行 ID 前缀
      await expect(page.getByText(new RegExp(RUN_ID.slice(0, 8)))).toBeVisible()
    })

    test('空运行列表时展示空状态', async ({ page }) => {
      await setupStudioMocks(page, { runs: [] })
      await page.goto(`/studio/${STUDIO_ID}/runs`)

      await expect(page.getByText(/暂无运行记录/)).toBeVisible()
    })

    test('点击运行记录跳转到详情页', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs`)

      // 点击运行行
      await page.getByText(new RegExp(RUN_ID.slice(0, 8))).click()
      await expect(page).toHaveURL(new RegExp(`/studio/${STUDIO_ID}/runs/${RUN_ID}`))
    })

    test('点击运行按钮打开运行弹窗', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs`)

      await page.getByRole('button', { name: /运行/ }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('从运行历史页启动运行并跳转到详情', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs`)

      await page.getByRole('button', { name: /运行/ }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const [response] = await Promise.all([
        page.waitForResponse((res) =>
          res.url().includes(`/studios/${STUDIO_ID}/runs`) && res.request().method() === 'POST'
        ),
        page.getByRole('dialog').getByRole('button', { name: /运行/ }).click(),
      ])

      expect(response.ok()).toBeTruthy()
      await expect(page).toHaveURL(new RegExp(`/studio/${STUDIO_ID}/runs/${RUN_ID}`))
    })
  })

  // -------------------------------------------------------------------------
  // 4. 运行详情页
  // -------------------------------------------------------------------------
  test.describe('运行详情页', () => {
    test('展示已完成运行的状态和节点结果', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      // 页面标题
      await expect(page.getByRole('heading', { name: /运行详情/ })).toBeVisible()

      // 状态徽章 - 已完成（在 summary card 内的 RunStatusBadge）
      await expect(page.locator('.rounded-full').filter({ hasText: '已完成' }).first()).toBeVisible()

      // 节点结果区域
      await expect(page.getByText(/节点结果/)).toBeVisible()

      // 节点 ID
      await expect(page.getByText('node_1')).toBeVisible()
    })

    test('展示运行中状态和进度条', async ({ page }) => {
      const runningRun = {
        ...MOCK_RUN,
        status: 'running' as const,
        completedAt: null,
        nodeResults: {
          node_1: { status: 'completed' as const, output: { text: '完成', files: [] } },
          node_2: { status: 'running' as const },
        },
      }
      await setupStudioMocks(page, { run: runningRun })
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      // 运行中状态
      await expect(page.locator('.rounded-full').filter({ hasText: '运行中' }).first()).toBeVisible()

      // 进度条容器存在于 DOM（overflow-hidden 导致 Playwright 认为 hidden，用 toBeAttached）
      await expect(page.locator('.h-1\\.5.bg-muted.rounded-full')).toBeAttached()

      // 取消按钮
      await expect(page.getByRole('button', { name: /取消运行/ })).toBeVisible()
    })

    test('展示失败运行的错误信息', async ({ page }) => {
      const failedRun = {
        ...MOCK_RUN,
        status: 'failed' as const,
        error: '节点执行超时',
        nodeResults: {
          node_1: { status: 'failed' as const, error: '执行超时' },
        },
      }
      await setupStudioMocks(page, { run: failedRun })
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      // 状态徽章 - 失败（精确匹配 RunStatusBadge）
      await expect(page.locator('.rounded-full').filter({ hasText: '失败' }).first()).toBeVisible()
      await expect(page.getByText('节点执行超时')).toBeVisible()
    })

    test('展开节点结果查看输出内容', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      // 节点卡片默认折叠（completed 状态），点击展开
      const nodeCard = page.locator('button').filter({ hasText: 'node_1' })
      await nodeCard.click()

      // 输出内容
      await expect(page.getByText('节点执行完成')).toBeVisible()
    })

    test('点击返回按钮跳转到运行历史页', async ({ page }) => {
      await setupStudioMocks(page)
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      // 等待页面加载
      await expect(page.getByRole('heading', { name: /运行详情/ })).toBeVisible()
      // 返回按钮是 header 区域第一个按钮
      const header = page.locator('.flex.items-center.gap-2.mb-6').first()
      await header.getByRole('button').first().click()
      await expect(page).toHaveURL(new RegExp(`/studio/${STUDIO_ID}/runs$`))
    })

    test('pending 状态展示等待中提示', async ({ page }) => {
      const pendingRun = {
        ...MOCK_RUN,
        status: 'pending' as const,
        completedAt: null,
        nodeResults: {},
      }
      await setupStudioMocks(page, { run: pendingRun })
      await page.goto(`/studio/${STUDIO_ID}/runs/${RUN_ID}`)

      await expect(page.getByText('等待中')).toBeVisible()
      await expect(page.getByText(/等待执行中/)).toBeVisible()
    })
  })
})
