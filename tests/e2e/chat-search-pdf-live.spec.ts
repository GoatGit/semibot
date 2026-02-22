import { expect, test } from '@playwright/test'
import { loginByApi } from './helpers/auth'

test.setTimeout(240_000)

test('live: 搜索代理2 搜索并生成 PDF，消息可见、流程结束、文件可下载', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'skip webkit to keep runtime test stable')

  await loginByApi(page)
  await page.goto('/chat/new')

  const agentCard = page.getByRole('button', { name: /搜索代理2/ })
  await expect(agentCard).toBeVisible({ timeout: 15_000 })
  await agentCard.click()

  const prompt = '搜索最新的 AI 行业动态并总结，并生成PDF'
  await page.getByPlaceholder('输入您的问题或任务描述...').fill(prompt)
  await page.getByRole('button', { name: '开始对话' }).click()

  // 1) 从 /chat/new 跳转后应展示原问题
  await expect(page).toHaveURL(/\/chat\//, { timeout: 15_000 })
  await expect(page.getByText(prompt)).toBeVisible({ timeout: 20_000 })

  // 4) 流程应结束（停止按钮消失）
  await expect(page.getByRole('button', { name: /停止生成/ })).not.toBeVisible({ timeout: 180_000 })

  // 3) 生成并下载 PDF（非 135B 错误文件）
  const pdfCard = page.locator('div', { has: page.locator('p', { hasText: /\.pdf$/i }) }).first()
  await expect(pdfCard).toBeVisible({ timeout: 180_000 })

  await page.evaluate(() => {
    const w = window as typeof window & { __semibotLastDownloadFetch?: string; __semibotFetchPatched?: boolean }
    if (w.__semibotFetchPatched) return
    const nativeFetch = window.fetch.bind(window)
    w.__semibotFetchPatched = true
    w.__semibotLastDownloadFetch = ''
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/(?:api\/v1\/)?files\/[a-f0-9]{32}$/i.test(url)) {
        w.__semibotLastDownloadFetch = url
      }
      return nativeFetch(input, init)
    }
  })

  await pdfCard.getByRole('button', { name: '下载文件' }).click()

  await page.waitForFunction(
    () => Boolean((window as typeof window & { __semibotLastDownloadFetch?: string }).__semibotLastDownloadFetch),
    { timeout: 30_000 }
  )
  const downloadUrl = await page.evaluate(
    () => (window as typeof window & { __semibotLastDownloadFetch?: string }).__semibotLastDownloadFetch || ''
  )
  expect(downloadUrl).toMatch(/\/(?:api\/v1\/)?files\/[a-f0-9]{32}$/i)

  const token = await page.evaluate(() => localStorage.getItem('auth_token') || '')
  expect(token.length).toBeGreaterThan(20)

  const normalizedUrl = downloadUrl.startsWith('http')
    ? downloadUrl
    : `http://localhost:3001${downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`}`
  const verified = await page.request.get(normalizedUrl, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(verified.status()).toBe(200)
  expect((await verified.body()).byteLength).toBeGreaterThan(1024)

  await expect(async () => {
    const errorTextVisible = await page.getByText(/下载失败/i).isVisible().catch(() => false)
    expect(errorTextVisible).toBeFalsy()
  }).toPass({ timeout: 2000 })
})
