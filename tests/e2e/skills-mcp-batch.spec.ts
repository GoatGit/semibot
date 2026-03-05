import { test, expect, type Page, type Route } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function bootstrap(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('language', 'zh-CN')
    localStorage.setItem('locale', 'zh-CN')
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
}

async function setupSkillsMocks(page: Page) {
  let definitions = [
    { id: 'skill-1', name: 'Skill A', skillId: 'skill-a', description: 'A', category: 'general', isActive: true },
    { id: 'skill-2', name: 'Skill B', skillId: 'skill-b', description: 'B', category: 'general', isActive: true },
    { id: 'skill-3', name: 'Skill C', skillId: 'skill-c', description: 'C', category: 'general', isActive: true },
  ]

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const pathname = url.pathname
    const method = req.method()

    if (pathname.includes('/api/v1/sessions') && method === 'GET') {
      await json(route, { success: true, data: [], meta: { total: 0, page: 1, limit: 10, totalPages: 0 } })
      return
    }

    if (pathname === '/api/v1/runtime/skills' && method === 'GET') {
      await json(route, {
        success: true,
        data: {
          available: true,
          metadata: definitions.map((def) => ({
            skill_id: def.skillId,
            name: def.name,
            description: def.description,
            source: def.category,
            status: def.isActive ? 'active' : 'disabled',
            tags: [],
            installed_at: new Date().toISOString(),
            indexed_at: new Date().toISOString(),
          })),
          skills: [],
        },
      })
      return
    }

    if (pathname === '/api/v1/control/skills/enable' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { payload?: { skill_id?: string } }
      const skillId = body.payload?.skill_id
      definitions = definitions.map((def) => (def.skillId === skillId ? { ...def, isActive: true } : def))
      await json(route, { success: true, data: { ok: true } })
      return
    }

    if (pathname === '/api/v1/control/skills/disable' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { payload?: { skill_id?: string } }
      const skillId = body.payload?.skill_id
      definitions = definitions.map((def) => (def.skillId === skillId ? { ...def, isActive: false } : def))
      await json(route, { success: true, data: { ok: true } })
      return
    }

    if (pathname === '/api/v1/control/skills/uninstall' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { payload?: { skill_id?: string } }
      const skillId = body.payload?.skill_id
      definitions = definitions.filter((def) => def.skillId !== skillId)
      await json(route, { success: true, data: { ok: true } })
      return
    }

    await json(route, { success: true, data: [] })
  })

  return {
    count: () => definitions.length,
    activeCount: () => definitions.filter((def) => def.isActive).length,
  }
}

async function setupMcpMocks(page: Page) {
  let servers = [
    {
      id: 'mcp-1',
      name: 'MCP A',
      description: 'A',
      transport: 'streamable_http',
      endpoint: 'https://example-a.com/mcp',
      status: 'disconnected',
      tools: [],
      resources: [],
      isSystem: false,
    },
    {
      id: 'mcp-2',
      name: 'MCP B',
      description: 'B',
      transport: 'sse',
      endpoint: 'https://example-b.com/sse',
      status: 'disconnected',
      tools: [],
      resources: [],
      isSystem: false,
    },
    {
      id: 'mcp-3',
      name: 'MCP C',
      description: 'C',
      transport: 'stdio',
      endpoint: 'npx -y @example/mcp-c',
      status: 'disconnected',
      tools: [],
      resources: [],
      isSystem: true,
    },
  ]

  await page.route('**/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const pathname = url.pathname
    const method = req.method()

    if (pathname.includes('/api/v1/sessions') && method === 'GET') {
      await json(route, { success: true, data: [], meta: { total: 0, page: 1, limit: 10, totalPages: 0 } })
      return
    }

    if (pathname === '/api/v1/mcp' && method === 'GET') {
      await json(route, {
        success: true,
        data: servers,
        meta: { total: servers.length, page: 1, limit: 100, totalPages: 1 },
      })
      return
    }

    if (pathname === '/api/v1/control/mcp/test' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { payload?: { server_id?: string } }
      const id = body.payload?.server_id || ''
      servers = servers.map((server) => (
        server.id === id
          ? { ...server, status: 'connected', tools: [{ name: `${server.name.toLowerCase()}_tool` }] }
          : server
      ))
      await json(route, { success: true, data: { success: true, message: 'ok' } })
      return
    }

    if (pathname === '/api/v1/control/mcp/delete' && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { payload?: { server_id?: string } }
      const id = body.payload?.server_id || ''
      servers = servers.filter((server) => server.id !== id)
      await json(route, { success: true, data: { deleted: true } })
      return
    }

    await json(route, { success: true, data: [] })
  })

  return {
    count: () => servers.length,
    connectedCount: () => servers.filter((server) => server.status === 'connected').length,
  }
}

test.describe('Skills & MCP Batch Management', () => {
  test('skills page should support batch enable/disable/delete', async ({ page }) => {
    await bootstrap(page)
    const skillState = await setupSkillsMocks(page)

    await page.goto('/skills')
    await expect(page.getByRole('heading', { name: /技能|Skills/i })).toBeVisible({ timeout: 15000 })

    await page.getByTestId('skills-select-all').click()
    await expect(page.getByText('已选择 3 个技能')).toBeVisible()

    await page.getByTestId('skills-batch-disable').click()
    await expect.poll(() => skillState.activeCount()).toBe(0)
    await expect(page.getByRole('button', { name: '启用' })).toHaveCount(3)

    await page.getByTestId('skills-select-all').click()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId('skills-batch-delete').click()
    await expect.poll(() => skillState.count()).toBe(0)
    await expect(page.getByText('没有找到技能定义')).toBeVisible()
  })

  test('mcp page should support batch test-and-sync/delete', async ({ page }) => {
    await bootstrap(page)
    const mcpState = await setupMcpMocks(page)

    await page.goto('/mcp')
    await expect(page.getByRole('heading', { name: /MCP Servers|MCP 服务器/i })).toBeVisible({ timeout: 15000 })

    await page.getByTestId('mcp-select-all').click()
    await expect(page.getByText('已选择 3 个 MCP')).toBeVisible()

    await page.getByTestId('mcp-batch-test-sync').click()
    await expect.poll(() => mcpState.connectedCount()).toBe(3)
    await expect(page.getByText('已连接')).toHaveCount(3)

    await page.getByTestId('mcp-select-all').click()
    page.once('dialog', (dialog) => dialog.accept())
    await page.getByTestId('mcp-batch-delete').click()
    await expect.poll(() => mcpState.count()).toBe(0)
    await expect(page.getByText('暂无 MCP 服务')).toBeVisible()
  })
})
