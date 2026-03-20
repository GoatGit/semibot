import { expect, test } from '@playwright/test'
import { loginByApi } from './helpers/auth'

test.skip(
  !process.env.RUN_LIVE_E2E,
  'Set RUN_LIVE_E2E=1 after API/Runtime are up to run live approval scenario.'
)

test.setTimeout(600_000)

async function assertPendingApprovalFlow(page: import('@playwright/test').Page, prompt: string) {
  await loginByApi(page)

  await page.goto('/chat/new')

  const systemAgentButton = page.getByRole('button', { name: /系统助手/i })
  await expect(systemAgentButton, 'System default agent button not found').toBeVisible({ timeout: 30_000 })
  await systemAgentButton.click()

  await page.getByPlaceholder('输入您的问题或任务描述...').fill(prompt)
  await page.getByRole('button', { name: /(开始对话|开始)/i }).click()

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}(?:\?|$)/i, { timeout: 20_000 })

  const pendingBanner = page.getByText(/待审批操作\s+\d+/)
  const terminatedText = page.getByText(/terminated/i)
  const pendingDeadline = Date.now() + 180_000

  while (Date.now() < pendingDeadline) {
    const deniedVisible = await page.getByText('approval_denied').isVisible().catch(() => false)
    expect(deniedVisible, 'approval_denied should not be visible before approval').toBeFalsy()
    const terminatedVisible = await terminatedText.isVisible().catch(() => false)
    expect(terminatedVisible, 'terminated should not be visible before approval').toBeFalsy()

    const pendingVisible = await pendingBanner.isVisible().catch(() => false)
    if (pendingVisible) break

    await page.waitForTimeout(3000)
  }

  await expect(pendingBanner, 'Expected request to enter pending approval state').toBeVisible({ timeout: 1000 })

  await page.reload()
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}(?:\?|$)/i, { timeout: 20_000 })
  await expect(pendingBanner, 'Pending approval should persist after refresh').toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('approval_denied')).toHaveCount(0)
  await expect(terminatedText).toHaveCount(0)

  const stopButton = page.getByRole('button', { name: '停止' })
  if (await stopButton.isVisible().catch(() => false)) {
    await stopButton.click()
  }

  const approveButton = page.getByRole('button', { name: '通过', exact: true })
  await expect(approveButton).toBeEnabled({ timeout: 30_000 })
  await approveButton.click()

  const resolvedDeadline = Date.now() + 120_000
  while (Date.now() < resolvedDeadline) {
    const deniedVisible = await page.getByText('approval_denied').isVisible().catch(() => false)
    expect(deniedVisible, 'approval_denied should not be visible after approval').toBeFalsy()
    const terminatedVisible = await terminatedText.isVisible().catch(() => false)
    expect(terminatedVisible, 'terminated should not be visible after approval').toBeFalsy()

    const stillPending = await pendingBanner.isVisible().catch(() => false)
    if (!stillPending) break

    await page.waitForTimeout(2000)
  }

  await expect(pendingBanner, 'Pending approval should disappear after approval').toHaveCount(0)
  await page.waitForTimeout(5000)
  await expect(page.getByText('approval_denied')).toHaveCount(0)
  await expect(terminatedText).toHaveCount(0)
}

test('live: 使用 browser_automation 搜索今天新闻时，审批前不会提前出现 approval_denied，刷新后待审批仍可恢复', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'live scenario only runs on chromium')
  await assertPendingApprovalFlow(page, '使用browser_automation搜索今天新闻')
})

test('live: 搜索今天新闻时，http_client 审批前不会提前出现 approval_denied，刷新后待审批仍可恢复', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'live scenario only runs on chromium')
  await assertPendingApprovalFlow(page, '搜索今天新闻')
})
