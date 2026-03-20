import { test, expect, type Page } from '@playwright/test'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

interface MockSkillDefinition {
  id: string
  name: string
  skillId: string
  description: string
  category: string
  isActive: boolean
}

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
}

test.describe('Skills directory upload', () => {
  test('upload directory should call runtime install upload and refresh runtime', async ({ page }) => {
    let defs: MockSkillDefinition[] = [
      {
        id: 'seed-1',
        name: 'Seed Skill',
        skillId: 'seed_skill',
        description: 'seed',
        category: 'general',
        isActive: true,
      },
    ]
    let installCalled = false
    let refreshCalled = false

    await page.route('**/api/v1/skill-definitions**', async (route, request) => {
      const method = request.method()
      const { pathname } = new URL(request.url())
      if (method === 'GET' && pathname.endsWith('/skill-definitions')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: defs,
            meta: { total: defs.length, page: 1, limit: 100, totalPages: 1 },
          }),
        })
        return
      }
      await route.continue()
    })

    await page.route('**/api/v1/runtime/skills/install/upload', async (route) => {
      installCalled = true
      defs = [
        {
          id: 'uploaded-1',
          name: 'Uploaded Dir Skill',
          skillId: 'uploaded_dir_skill',
          description: 'uploaded from directory',
          category: 'general',
          isActive: true,
        },
        ...defs,
      ]
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { ok: true, action: 'install', skill_name: 'uploaded_dir_skill' } }),
      })
    })

    await page.route('**/api/v1/runtime/skills/refresh-runtime', async (route) => {
      refreshCalled = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { reloaded: 1, new_tools: ['uploaded_dir_skill'], skipped: [] } }),
      })
    })

    await login(page)
    await page.goto('/skills', { waitUntil: 'domcontentloaded' })

    const createButton = page.getByRole('button', { name: /创建技能|新建|Create/i }).first()
    await createButton.click()

    await page.getByRole('button', { name: /选择目录|Directory/i }).click()
    const dirInput = page.locator('input[type="file"][multiple]').first()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-skill-dir-'))
    const skillDir = path.join(root, 'demo-skill')
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'scripts', 'main.py'), "print('hello')\n", 'utf-8')
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Demo Skill\n', 'utf-8')
    await dirInput.setInputFiles(skillDir)

    await page.getByRole('button', { name: /上传|Upload|Create/i }).last().click()

    await expect.poll(() => installCalled).toBeTruthy()
    await expect.poll(() => refreshCalled).toBeTruthy()
    await expect(page.getByText('Uploaded Dir Skill')).toBeVisible()
  })
})
