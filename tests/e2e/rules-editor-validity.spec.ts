import { test, expect, type Page, type Request, type Route } from '@playwright/test'

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

async function chooseOption(dialog: ReturnType<Page['locator']>, selectIndex: number, optionLabel: string) {
  await dialog.locator('button[role="combobox"]').nth(selectIndex).click()
  await dialog.getByRole('option', { name: optionLabel }).click()
}

test.describe('Rules Editor Validity', () => {
  test('create/edit cron rule with all key fields should be effective', async ({ page }) => {
    await mockCommon(page)

    const rules: Array<Record<string, unknown>> = []
    let cronJobs: Array<{ name: string, schedule: string }> = []
    let createPayload: Record<string, unknown> | null = null
    let updatePayload: Record<string, unknown> | null = null
    let deletedCronJobName: string | null = null

    await page.route('**/api/v1/rules', async (route: Route, request: Request) => {
      if (request.method() === 'GET') {
        await json(route, { items: rules })
        return
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>
        createPayload = body
        rules.push({
          id: 'rule_daily_digest',
          name: body.name,
          event_type: body.event_type,
          conditions: body.conditions,
          action_mode: body.action_mode,
          actions: body.actions,
          risk_level: body.risk_level,
          priority: body.priority,
          dedupe_window_seconds: body.dedupe_window_seconds,
          cooldown_seconds: body.cooldown_seconds,
          attention_budget_per_day: body.attention_budget_per_day,
          is_active: true,
        })
        const cron = body.cron as Record<string, unknown> | undefined
        if (cron?.name && cron?.schedule) {
          cronJobs.push({ name: String(cron.name), schedule: String(cron.schedule) })
        }
        await json(route, { success: true, id: 'rule_daily_digest' }, 201)
        return
      }
      await route.continue()
    })

    await page.route('**/api/v1/rules/*', async (route: Route, request: Request) => {
      if (request.method() !== 'PUT') {
        await route.continue()
        return
      }
      const body = request.postDataJSON() as Record<string, unknown>
      updatePayload = body
      const idx = rules.findIndex((item) => item.id === 'rule_daily_digest')
      if (idx >= 0) {
        rules[idx] = {
          ...rules[idx],
          name: body.name ?? rules[idx].name,
          event_type: body.event_type ?? rules[idx].event_type,
          conditions: body.conditions ?? rules[idx].conditions,
          action_mode: body.action_mode ?? rules[idx].action_mode,
          actions: body.actions ?? rules[idx].actions,
          risk_level: body.risk_level ?? rules[idx].risk_level,
          priority: body.priority ?? rules[idx].priority,
          dedupe_window_seconds: body.dedupe_window_seconds ?? rules[idx].dedupe_window_seconds,
          cooldown_seconds: body.cooldown_seconds ?? rules[idx].cooldown_seconds,
          attention_budget_per_day: body.attention_budget_per_day ?? rules[idx].attention_budget_per_day,
        }
      }
      await json(route, { success: true, data: rules[idx] ?? null })
    })

    await page.route('**/api/v1/runtime/scheduler/cron-jobs', async (route: Route) => {
      await json(route, { data: { jobs: cronJobs } })
    })

    await page.route('**/api/v1/runtime/scheduler/cron-jobs/*', async (route: Route, request: Request) => {
      if (request.method() !== 'DELETE') {
        await route.continue()
        return
      }
      deletedCronJobName = decodeURIComponent(request.url().split('/').pop() || '')
      cronJobs = cronJobs.filter((job) => job.name !== deletedCronJobName)
      await json(route, { success: true, deleted: true })
    })

    await page.goto('/rules')
    await expect(page.getByRole('heading', { name: '规则管理' })).toBeVisible()

    await page.getByRole('button', { name: '新建规则' }).click()
    const dialog = page.getByRole('dialog', { name: '新建规则' })
    await expect(dialog).toBeVisible()

    await dialog.locator('input').first().fill('daily_news_digest')
    await chooseOption(dialog, 0, 'cron.job.tick')

    await expect(dialog.getByText('联动创建/更新 Cron 调度器')).toBeVisible()
    await dialog.getByRole('textbox', { name: 'daily_digest' }).fill('daily_news_digest')
    await dialog.getByRole('textbox', { name: '*/5 * * * *' }).fill('0 9 * * 1-5')

    await chooseOption(dialog, 1, '按名称触发的 Cron')
    await chooseOption(dialog, 2, 'auto')
    await chooseOption(dialog, 3, 'medium')

    await dialog.getByRole('button', { name: '新增动作' }).click()
    await chooseOption(dialog, 5, 'run_agent')

    const numberInputs = dialog.locator('input[type="number"]')
    await numberInputs.nth(0).fill('88')
    await numberInputs.nth(1).fill('180')
    await numberInputs.nth(2).fill('120')
    await numberInputs.nth(3).fill('25')

    await dialog.getByRole('button', { name: '创建' }).click()

    await expect.poll(() => createPayload).not.toBeNull()
    expect(createPayload).toMatchObject({
      name: 'daily_news_digest',
      event_type: 'cron.job.tick',
      action_mode: 'auto',
      risk_level: 'medium',
      priority: 88,
      dedupe_window_seconds: 180,
      cooldown_seconds: 120,
      attention_budget_per_day: 25,
      cron: {
        upsert: true,
        name: 'daily_news_digest',
        schedule: '0 9 * * 1-5',
      },
    })
    await expect(page.locator('p').filter({ hasText: /^daily_news_digest$/ })).toBeVisible()
    await expect(page.getByText('cron=daily_news_digest (0 9 * * 1-5)')).toBeVisible()

    await page.getByRole('button', { name: '编辑' }).first().click()
    const editDialog = page.getByRole('dialog', { name: '编辑规则' })
    await expect(editDialog).toBeVisible()
    await expect(editDialog.getByText('联动创建/更新 Cron 调度器')).toBeVisible()

    const cronToggle = editDialog.locator('label', { hasText: '联动创建/更新 Cron 调度器' }).locator('input[type="checkbox"]')
    await expect(cronToggle).toBeChecked()
    await cronToggle.uncheck()

    const editNumberInputs = editDialog.locator('input[type="number"]')
    await editNumberInputs.nth(0).fill('66')
    await editDialog.getByRole('button', { name: '保存' }).click()

    await expect.poll(() => updatePayload).not.toBeNull()
    expect(updatePayload).toMatchObject({
      priority: 66,
      event_type: 'cron.job.tick',
    })
    await expect.poll(() => deletedCronJobName).toBe('daily_news_digest')
  })
})
