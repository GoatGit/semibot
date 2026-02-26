import { test, expect, type Page, type Route, type Request } from '@playwright/test'

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockCommon(page: Page) {
  await page.route('**/api/v1/sessions**', async (route) => {
    await json(route, { success: true, data: [], meta: { total: 0, page: 1, limit: 10, totalPages: 0 } })
  })
}

test.describe('Event Engine Pages', () => {
  test('events page should render and replay event', async ({ page }) => {
    await mockCommon(page)

    let replayPayload: Record<string, unknown> | null = null
    await page.route('**/api/v1/events**', async (route, request) => {
      if (request.method() === 'GET') {
        await json(route, {
          success: true,
          items: [
            {
              id: 'evt_1',
              event_type: 'task.completed',
              source: 'agent',
              subject: 'task:123',
              payload: { result: 'ok' },
              risk_hint: 'low',
              created_at: '2026-02-26T12:00:00Z',
            },
          ],
        })
        return
      }

      if (request.method() === 'POST' && request.url().includes('/events/replay')) {
        replayPayload = request.postDataJSON() as Record<string, unknown>
        await json(route, { success: true, accepted: true, replay_id: 'rpl_1' })
        return
      }

      await route.continue()
    })

    await page.goto('/events')
    await expect(page.getByRole('heading', { name: '事件中心' })).toBeVisible()
    await expect(page.locator('p').filter({ hasText: 'task.completed' }).first()).toBeVisible()

    await page.getByRole('button', { name: '详情' }).first().click()
    const eventDetailDialog = page.getByRole('dialog', { name: '事件详情' })
    await expect(eventDetailDialog).toBeVisible()
    await expect(eventDetailDialog.getByText('task:123')).toBeVisible()
    await page.getByRole('button', { name: '关闭' }).click()

    await page.getByRole('button', { name: '回放' }).first().click()
    await expect.poll(() => replayPayload).not.toBeNull()
    expect(replayPayload).toMatchObject({ event_id: 'evt_1' })
  })

  test('rules page should create, toggle and edit rule', async ({ page }) => {
    await mockCommon(page)

    const rules: Array<Record<string, unknown>> = [
      {
        id: 'rule_1',
        name: 'boot_notice',
        event_type: 'system.boot.completed',
        action_mode: 'suggest',
        risk_level: 'low',
        priority: 50,
        dedupe_window_seconds: 300,
        cooldown_seconds: 600,
        attention_budget_per_day: 10,
        is_active: true,
        created_at: '2026-02-26T12:00:00Z',
        updated_at: '2026-02-26T12:00:00Z',
      },
    ]

    await page.route('**/api/v1/rules**', async (route: Route, request: Request) => {
      if (request.method() === 'GET') {
        await json(route, { success: true, items: rules })
        return
      }

      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>
        rules.push({
          id: 'rule_2',
          name: body.name,
          event_type: body.event_type,
          action_mode: body.action_mode ?? 'suggest',
          risk_level: body.risk_level ?? 'low',
          priority: body.priority ?? 50,
          dedupe_window_seconds: body.dedupe_window_seconds ?? 300,
          cooldown_seconds: body.cooldown_seconds ?? 600,
          attention_budget_per_day: body.attention_budget_per_day ?? 10,
          is_active: body.is_active ?? true,
          created_at: '2026-02-26T12:00:00Z',
          updated_at: '2026-02-26T12:00:00Z',
        })
        await json(route, { success: true, id: 'rule_2', created: true }, 201)
        return
      }

      await route.continue()
    })

    await page.route('**/api/v1/rules/*', async (route: Route, request: Request) => {
      if (request.method() === 'PUT') {
        const id = request.url().split('/').pop()
        const body = request.postDataJSON() as Record<string, unknown>
        const idx = rules.findIndex((item) => item.id === id)
        if (idx >= 0) {
          rules[idx] = { ...rules[idx], ...body, updated_at: '2026-02-26T12:01:00Z' }
          if (body.event_type !== undefined) rules[idx].event_type = body.event_type
          if (body.action_mode !== undefined) rules[idx].action_mode = body.action_mode
          if (body.risk_level !== undefined) rules[idx].risk_level = body.risk_level
          if (body.is_active !== undefined) rules[idx].is_active = body.is_active
        }
        await json(route, { success: true, data: rules[idx] })
        return
      }
      await route.continue()
    })

    await page.goto('/rules')
    await expect(page.getByRole('heading', { name: '规则管理' })).toBeVisible()

    await page.getByRole('button', { name: '新建规则' }).click()
    await page.getByPlaceholder('规则名称').fill('tool_fail_alert')
    await page.getByPlaceholder('事件类型（例如 tool.exec.failed）').fill('tool.exec.failed')
    await page.getByRole('button', { name: '创建' }).click()

    await expect(page.getByText('tool_fail_alert')).toBeVisible()

    await page.getByRole('button', { name: '停用' }).first().click()
    await expect(page.getByText('inactive')).toBeVisible()

    await page.getByRole('button', { name: '编辑' }).last().click()
    await page.getByPlaceholder('规则名称').fill('tool_fail_alert_v2')
    await page.getByRole('button', { name: '保存' }).click()

    await expect(page.getByText('tool_fail_alert_v2')).toBeVisible()
  })

  test('approvals page should approve and reject', async ({ page }) => {
    await mockCommon(page)

    const approvals: Array<Record<string, unknown>> = [
      {
        id: 'appr_1',
        event_type: 'tool.exec.high_risk',
        status: 'pending',
        risk_level: 'high',
        reason: '需要人工确认',
        created_at: '2026-02-26T12:00:00Z',
      },
      {
        id: 'appr_2',
        event_type: 'task.auto.execute',
        status: 'pending',
        risk_level: 'medium',
        reason: '需审批',
        created_at: '2026-02-26T12:00:01Z',
      },
    ]

    await page.route('**/api/v1/approvals**', async (route, request) => {
      if (request.method() !== 'GET') {
        await route.continue()
        return
      }

      const url = new URL(request.url())
      const status = url.searchParams.get('status')
      const items =
        status && status !== 'all'
          ? approvals.filter((item) => String(item.status) === status)
          : approvals
      await json(route, { success: true, items })
    })

    await page.route('**/api/v1/approvals/*/*', async (route, request) => {
      if (request.method() !== 'POST') {
        await route.continue()
        return
      }
      const parts = request.url().split('/')
      const id = parts[parts.length - 2]
      const decision = parts[parts.length - 1]
      const idx = approvals.findIndex((item) => item.id === id)
      if (idx >= 0) {
        approvals[idx].status = decision === 'approve' ? 'approved' : 'rejected'
      }
      await json(route, { success: true, id, status: approvals[idx]?.status ?? 'pending', resolved: true })
    })

    await page.goto('/approvals')
    await expect(page.getByRole('heading', { name: '审批中心' })).toBeVisible()

    await page.getByRole('button', { name: '批准' }).first().click()
    await expect(page.getByText('approved')).toBeVisible()

    await page.getByRole('button', { name: '拒绝' }).first().click()
    await expect(page.getByText('rejected')).toBeVisible()
  })
})
