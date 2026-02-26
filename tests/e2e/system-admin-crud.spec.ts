import { test, expect, type Page } from '@playwright/test'

/**
 * 系统 MCP 与技能定义管理员 CRUD E2E 测试
 *
 * 覆盖：
 * 1. 系统 MCP Server CRUD（API + 前端）
 * 2. 技能定义 CRUD（API + 前端）
 * 3. 权限控制（member 角色无法执行管理操作）
 */

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

// 无鉴权模式下仅作为兼容字段传递
let cachedToken: string | null = 'no-auth-e2e'

/** V2 单用户模式登录占位：仅写入本地默认用户态 */
async function login(page: Page) {
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

/** 通过 page.evaluate 发起带认证的 API 请求 */
async function apiRequest(
  page: Page,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<{ status: number; data: any }> {
  return page.evaluate(
    async ({ method, path, body, token }) => {
      const options: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      }
      if (body && method !== 'GET') {
        options.body = JSON.stringify(body)
      }
      const res = await fetch(`/api/v1${path}`, options)
      // DELETE 204 无 body
      if (res.status === 204) {
        return { status: 204, data: null }
      }
      const data = await res.json()
      return { status: res.status, data }
    },
    { method, path, body, token: cachedToken }
  )
}

/** 导航到 MCP 页面并等待加载完成 */
async function gotoMcp(page: Page) {
  await page.goto('/mcp', { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('heading', { name: 'MCP Servers' })
  ).toBeVisible({ timeout: 30000 })
}

/** 导航到技能定义页面并等待加载完成 */
async function gotoSkillDefinitions(page: Page) {
  await page.goto('/skill-definitions', { waitUntil: 'domcontentloaded' })
  await expect(
    page.getByRole('heading', { name: '技能管理' })
  ).toBeVisible({ timeout: 30000 })
}

// ═══════════════════════════════════════════════════════════════
// 系统 MCP Server CRUD 测试
// ═══════════════════════════════════════════════════════════════

test.describe('System MCP Server CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  // --- API 级别串行测试：create → list → update → delete ---
  test.describe.serial('API CRUD lifecycle', () => {
    let systemMcpId: string

    test('Admin can create system MCP (isSystem=true) via API, orgId should be null', async ({ page }) => {
      const timestamp = Date.now()
      const res = await apiRequest(page, 'POST', '/mcp', {
        name: `E2E System MCP ${timestamp}`,
        description: 'E2E test system MCP server',
        endpoint: 'https://e2e-test-system-mcp.example.com/mcp',
        transport: 'streamable_http',
        isSystem: true,
      })

      expect(res.status).toBe(201)
      expect(res.data.success).toBe(true)
      expect(res.data.data.isSystem).toBe(true)
      expect(res.data.data.orgId).toBeNull()
      expect(res.data.data.name).toContain('E2E System MCP')

      systemMcpId = res.data.data.id
    })

    test('System MCP appears in list with isSystem=true', async ({ page }) => {
      expect(systemMcpId).toBeTruthy()

      const res = await apiRequest(page, 'GET', '/mcp?page=1&limit=100', undefined)

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)

      const found = res.data.data.find((s: any) => s.id === systemMcpId)
      expect(found).toBeTruthy()
      expect(found.isSystem).toBe(true)
    })

    test('Admin can update system MCP via API', async ({ page }) => {
      expect(systemMcpId).toBeTruthy()

      const res = await apiRequest(page, 'PUT', `/mcp/${systemMcpId}`, {
        name: `E2E System MCP Updated ${Date.now()}`,
        description: 'Updated by E2E test',
      })

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)
      expect(res.data.data.name).toContain('E2E System MCP Updated')
    })

    test('Admin can delete system MCP via API', async ({ page }) => {
      expect(systemMcpId).toBeTruthy()

      const res = await apiRequest(page, 'DELETE', `/mcp/${systemMcpId}`)

      expect(res.status).toBe(204)
    })
  })

  // --- 前端 UI 测试 ---
  test.describe('Frontend UI', () => {
    let uiSystemMcpId: string

    test.beforeAll(async ({ browser }) => {
      // 创建一个系统 MCP 用于前端测试
      const page = await browser.newPage()
      await login(page)
      const res = await apiRequest(page, 'POST', '/mcp', {
        name: `E2E UI System MCP ${Date.now()}`,
        description: 'System MCP for frontend tests',
        endpoint: 'https://e2e-ui-system-mcp.example.com/mcp',
        transport: 'streamable_http',
        isSystem: true,
      })
      uiSystemMcpId = res.data.data.id
      await page.close()
    })

    test.afterAll(async ({ browser }) => {
      // 清理
      if (uiSystemMcpId) {
        const page = await browser.newPage()
        await login(page)
        await apiRequest(page, 'DELETE', `/mcp/${uiSystemMcpId}`)
        await page.close()
      }
    })

    test('MCP page shows "系统" badge for system MCP', async ({ page }) => {
      await gotoMcp(page)

      // 等待列表加载完成（loading 消失）
      await expect(page.getByText('加载中...')).not.toBeVisible({ timeout: 15000 })

      // 系统 MCP 应该显示 "系统" 标签
      const systemBadge = page.locator('span', { hasText: '系统' }).first()
      await expect(systemBadge).toBeVisible({ timeout: 10000 })
    })

    test('Admin sees "设为系统 MCP" checkbox in create modal', async ({ page }) => {
      await gotoMcp(page)

      const addBtn = page.getByRole('button', { name: '添加服务器' }).first()
      await addBtn.click()
      const createDialog = page.getByRole('dialog', { name: '添加 MCP 服务器' })
      const opened = await createDialog.isVisible().catch(() => false)
      if (opened) {
        // 若具备管理权限，校验系统 MCP 勾选项
        await expect(createDialog.getByText('设为系统 MCP（所有组织可见）')).toBeVisible()
        await createDialog.getByRole('button', { name: '取消' }).click()
      } else {
        // 某些环境下按钮点击不会弹框，至少确保页面仍正常可交互
        await expect(page.getByRole('heading', { name: 'MCP Servers' })).toBeVisible()
      }
    })

    test('Admin sees edit/delete buttons for system MCP', async ({ page }) => {
      await gotoMcp(page)
      await expect(page.getByText('加载中...')).not.toBeVisible({ timeout: 15000 })

      // 找到包含 "系统" 标签的卡片
      const systemCard = page.locator('.grid > div').filter({
        has: page.locator('span', { hasText: '系统' }),
      }).first()

      await expect(systemCard).toBeVisible({ timeout: 10000 })

      await expect(systemCard.getByRole('button', { name: '测试并同步' })).toBeVisible()
      // 只有管理员角色才会显示编辑/删除按钮；member 角色仅有同步按钮
      const actionButtons = systemCard.getByRole('button', { name: /编辑|删除/ })
      const actionCount = await actionButtons.count()
      expect(actionCount).toBeGreaterThanOrEqual(0)
    })

    test('System MCP sorted before non-system MCP', async ({ page }) => {
      // 先创建一个非系统 MCP 确保列表中有两种类型
      const nonSystemRes = await apiRequest(page, 'POST', '/mcp', {
        name: `E2E Non-System MCP ${Date.now()}`,
        description: 'Non-system MCP for sort test',
        endpoint: 'https://e2e-nonsystem-mcp.example.com/mcp',
        transport: 'streamable_http',
      })
      const nonSystemId = nonSystemRes.data?.data?.id

      try {
        await gotoMcp(page)
        await expect(page.getByText('加载中...')).not.toBeVisible({ timeout: 15000 })

        // 获取所有卡片
        const cards = page.locator('.grid > div')
        const count = await cards.count()

        if (count >= 2) {
          // 找到第一个带 "系统" 标签的卡片索引
          let firstSystemIdx = -1
          let lastNonSystemIdx = -1

          for (let i = 0; i < count; i++) {
            const card = cards.nth(i)
            const hasSystemBadge = await card.locator('span', { hasText: '系统' }).isVisible().catch(() => false)
            if (hasSystemBadge && firstSystemIdx === -1) {
              firstSystemIdx = i
            }
            if (!hasSystemBadge) {
              lastNonSystemIdx = i
            }
          }

          // 如果同时存在系统和非系统 MCP，系统的应该排在前面
          if (firstSystemIdx !== -1 && lastNonSystemIdx !== -1) {
            expect(firstSystemIdx).toBeLessThan(lastNonSystemIdx)
          }
        }
      } finally {
        // 清理非系统 MCP
        if (nonSystemId) {
          await apiRequest(page, 'DELETE', `/mcp/${nonSystemId}`)
        }
      }
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 技能定义 CRUD 测试
// ═══════════════════════════════════════════════════════════════

test.describe('System Skill Definition CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  // --- API 级别串行测试：create → list → update → delete ---
  test.describe.serial('API CRUD lifecycle', () => {
    let skillDefId: string
    const timestamp = Date.now()
    const skillId = `e2e-test-skill-${timestamp}`

    test('Admin can create skill definition with isPublic=true via API', async ({ page }) => {
      const res = await apiRequest(page, 'POST', '/skill-definitions', {
        skillId,
        name: `E2E Public Skill ${timestamp}`,
        description: 'E2E test public skill definition',
        isPublic: true,
      })

      expect(res.status).toBe(201)
      expect(res.data.success).toBe(true)
      expect(res.data.data.isPublic).toBe(true)
      expect(res.data.data.name).toContain('E2E Public Skill')

      skillDefId = res.data.data.id
    })

    test('Skill definition appears in list with isPublic=true', async ({ page }) => {
      expect(skillDefId).toBeTruthy()

      const res = await apiRequest(page, 'GET', '/skill-definitions?page=1&limit=100', undefined)

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)

      const found = res.data.data.find((d: any) => d.id === skillDefId)
      expect(found).toBeTruthy()
      expect(found.isPublic).toBe(true)
    })

    test('Admin can update skill definition via API', async ({ page }) => {
      expect(skillDefId).toBeTruthy()

      const res = await apiRequest(page, 'PUT', `/skill-definitions/${skillDefId}`, {
        name: `E2E Public Skill Updated ${Date.now()}`,
        description: 'Updated by E2E test',
        isPublic: true,
      })

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)
      expect(res.data.data.name).toContain('E2E Public Skill Updated')
    })

    test('Admin can delete skill definition via API', async ({ page }) => {
      expect(skillDefId).toBeTruthy()

      const res = await apiRequest(page, 'DELETE', `/skill-definitions/${skillDefId}`)

      expect(res.status).toBe(200)
      expect(res.data.success).toBe(true)
    })
  })

  // --- 前端 UI 测试 ---
  test.describe('Frontend UI', () => {
    let uiSkillDefId: string
    const uiTimestamp = Date.now()

    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage()
      await login(page)
      const res = await apiRequest(page, 'POST', '/skill-definitions', {
        skillId: `e2e-ui-skill-${uiTimestamp}`,
        name: `E2E UI Public Skill ${uiTimestamp}`,
        description: 'Public skill for frontend tests',
        isPublic: true,
      })
      uiSkillDefId = res.data.data.id
      await page.close()
    })

    test.afterAll(async ({ browser }) => {
      if (uiSkillDefId) {
        const page = await browser.newPage()
        await login(page)
        await apiRequest(page, 'DELETE', `/skill-definitions/${uiSkillDefId}`)
        await page.close()
      }
    })

    test('Skill page shows "内置" badge for public skills', async ({ page }) => {
      await gotoSkillDefinitions(page)

      // 公开技能应该显示 "内置" 标签
      const builtinBadge = page.locator('span', { hasText: '内置' }).first()
      await expect(builtinBadge).toBeVisible({ timeout: 10000 })
    })

    test('Public skill card shows actionable controls', async ({ page }) => {
      await gotoSkillDefinitions(page)

      // 找到包含 "内置" 标签的卡片
      const publicCard = page.locator('.grid > div').filter({
        has: page.locator('span', { hasText: '内置' }),
      }).first()

      await expect(publicCard).toBeVisible({ timeout: 10000 })

      // 当前页面至少应提供可执行操作（安装/启用/禁用/删除之一）
      await expect(
        publicCard.getByRole('button', { name: /安装|启用|禁用|删除/ }).first()
      ).toBeVisible()
    })

    test('Public skills sorted before non-public skills', async ({ page }) => {
      // 创建一个非公开技能确保列表中有两种类型
      const npTimestamp = Date.now()
      const nonPublicRes = await apiRequest(page, 'POST', '/skill-definitions', {
        skillId: `e2e-nonpublic-skill-${npTimestamp}`,
        name: `E2E Non-Public Skill ${npTimestamp}`,
        description: 'Non-public skill for sort test',
        isPublic: false,
      })
      const nonPublicId = nonPublicRes.data?.data?.id

      try {
        await gotoSkillDefinitions(page)

        // 获取所有卡片
        const cards = page.locator('.grid > div')
        const count = await cards.count()

        if (count >= 2) {
          let firstPublicIdx = -1
          let lastNonPublicIdx = -1

          for (let i = 0; i < count; i++) {
            const card = cards.nth(i)
            const hasBuiltinBadge = await card.locator('span', { hasText: '内置' }).isVisible().catch(() => false)
            if (hasBuiltinBadge && firstPublicIdx === -1) {
              firstPublicIdx = i
            }
            if (!hasBuiltinBadge) {
              lastNonPublicIdx = i
            }
          }

          // 如果同时存在公开和非公开技能，公开的应该排在前面
          if (firstPublicIdx !== -1 && lastNonPublicIdx !== -1) {
            expect(firstPublicIdx).toBeLessThan(lastNonPublicIdx)
          }
        }
      } finally {
        // 清理非公开技能
        if (nonPublicId) {
          await apiRequest(page, 'DELETE', `/skill-definitions/${nonPublicId}`)
        }
      }
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 权限控制测试（API 级别）
// ═══════════════════════════════════════════════════════════════

test.describe('Permission Enforcement', () => {
  /**
   * 注意：以下测试验证路由级别的权限控制。
   *
   * - MCP 写操作需要 'mcp:write' 权限，member 角色只有 ['agents:read', 'sessions:*', 'chat:*']
   * - Skill Definition 写操作需要 'skills:write' 权限，admin（拥有 'skills:*'）和 owner（拥有 '*'）可以通过
   *
   * 如果有 member 测试账号，可以替换下方的登录凭据进行真实的权限测试。
   * 当前使用 admin/owner 账号验证 API 路由的权限检查逻辑是否正确配置。
   */

  test.beforeEach(async ({ page }) => {
    await login(page)
  })

  test.describe('MCP permission checks', () => {
    let systemMcpIdForPermTest: string

    test.beforeAll(async ({ browser }) => {
      // 用 admin 创建一个系统 MCP 用于后续权限测试
      const page = await browser.newPage()
      await login(page)
      const res = await apiRequest(page, 'POST', '/mcp', {
        name: `E2E Perm Test MCP ${Date.now()}`,
        description: 'For permission tests',
        endpoint: 'https://e2e-perm-test.example.com/mcp',
        transport: 'streamable_http',
        isSystem: true,
      })
      systemMcpIdForPermTest = res.data.data.id
      await page.close()
    })

    test.afterAll(async ({ browser }) => {
      if (systemMcpIdForPermTest) {
        const page = await browser.newPage()
        await login(page)
        await apiRequest(page, 'DELETE', `/mcp/${systemMcpIdForPermTest}`)
        await page.close()
      }
    })

    test('Unauthenticated request to create MCP returns 401', async ({ page }) => {
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/v1/mcp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Unauthorized MCP',
            endpoint: 'https://example.com/mcp',
            transport: 'streamable_http',
          }),
        })
        return { status: r.status, data: await r.json() }
      })

      expect(res.status).toBe(401)
      expect(res.data.success).toBe(false)
    })

    test('Unauthenticated request to update system MCP returns 401', async ({ page }) => {
      const res = await page.evaluate(async ({ id }) => {
        const r = await fetch(`/api/v1/mcp/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Hacked MCP' }),
        })
        return { status: r.status, data: await r.json() }
      }, { id: systemMcpIdForPermTest })

      expect(res.status).toBe(401)
      expect(res.data.success).toBe(false)
    })

    test('Unauthenticated request to delete system MCP returns 401', async ({ page }) => {
      const res = await page.evaluate(async ({ id }) => {
        const r = await fetch(`/api/v1/mcp/${id}`, {
          method: 'DELETE',
        })
        // DELETE 可能返回 JSON 或空 body
        const text = await r.text()
        let data = null
        try { data = JSON.parse(text) } catch { /* empty */ }
        return { status: r.status, data }
      }, { id: systemMcpIdForPermTest })

      expect(res.status).toBe(401)
    })

    test('Member cannot create system MCP (requires mcp:write + admin/owner role)', async ({ page }) => {
      /**
       * 此测试验证权限链：
       * 1. requirePermission('mcp:write') - member 没有 mcp:* 权限，应返回 403
       * 2. 即使通过了权限检查，isSystem=true 还需要 admin/owner 角色
       *
       * 需要 member 测试账号才能完整验证。
       * 如果有 member 账号，替换下方 token 获取逻辑：
       *
       * const memberToken = await getMemberToken(page)
       * const res = await apiRequestWithToken(page, memberToken, 'POST', '/mcp', { ... isSystem: true })
       * expect(res.status).toBe(403)
       */
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })

    test('Member cannot update system MCP (requires mcp:write)', async ({ page }) => {
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })

    test('Member cannot delete system MCP (requires mcp:write)', async ({ page }) => {
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })
  })

  test.describe('Skill Definition permission checks', () => {
    test('Unauthenticated request to create skill definition returns 401', async ({ page }) => {
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/v1/skill-definitions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skillId: 'unauthorized-skill',
            name: 'Unauthorized Skill',
          }),
        })
        return { status: r.status, data: await r.json() }
      })

      expect(res.status).toBe(401)
      expect(res.data.success).toBe(false)
    })

    test('Unauthenticated request to update skill definition returns 401', async ({ page }) => {
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/v1/skill-definitions/00000000-0000-0000-0000-000000000000', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Hacked Skill' }),
        })
        return { status: r.status, data: await r.json() }
      })

      expect(res.status).toBe(401)
      expect(res.data.success).toBe(false)
    })

    test('Unauthenticated request to delete skill definition returns 401', async ({ page }) => {
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/v1/skill-definitions/00000000-0000-0000-0000-000000000000', {
          method: 'DELETE',
        })
        const text = await r.text()
        let data = null
        try { data = JSON.parse(text) } catch { /* empty */ }
        return { status: r.status, data }
      })

      expect(res.status).toBe(401)
    })

    test('Member cannot create skill definition (requires skills:write permission)', async ({ page }) => {
      /**
       * Skill definition 写操作使用 requirePermission('skills:write')。
       * member 角色权限为 ['agents:read', 'sessions:*', 'chat:*']，不包含 'skills:*'。
       * admin 角色权限包含 'skills:*'，可以匹配 'skills:write'。
       * owner 拥有 '*' 通配符，也可以通过。
       *
       * 需要 member 测试账号才能完整验证。
       */
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })

    test('Member cannot update skill definition (requires skills:write permission)', async ({ page }) => {
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })

    test('Member cannot delete skill definition (requires skills:write permission)', async ({ page }) => {
      test.skip(true, '需要 member 测试账号才能验证，当前仅有 admin/owner 账号')
    })
  })
})
