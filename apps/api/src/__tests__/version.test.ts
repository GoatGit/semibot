import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveVersionPayload } from '../lib/version'

describe('resolveVersionPayload', () => {
  const originalEnv = { ...process.env }
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    process.env.SEMIBOT_RELEASE_VERSION = '2026.03.21.06'
    process.env.SEMIBOT_UPDATE_MANIFEST_URL = 'https://releases.semibot.ai/stable/latest.json'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    global.fetch = originalFetch
  })

  it('marks update available when manifest version is newer', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: '2026.03.21.07',
        archive_url: 'https://releases.semibot.ai/stable/semibot-2026.03.21.07.tar.gz',
        release_notes_url: 'https://semibot.ai/releases/2026.03.21.07',
        channel: 'stable',
      }),
    }) as typeof fetch

    const payload = await resolveVersionPayload()

    expect(payload.currentVersion).toBe('2026.03.21.06')
    expect(payload.latestVersion).toBe('2026.03.21.07')
    expect(payload.updateAvailable).toBe(true)
    expect(payload.releaseUrl).toBe('https://releases.semibot.ai/stable/semibot-2026.03.21.07.tar.gz')
    expect(payload.releaseNotesUrl).toBe('https://semibot.ai/releases/2026.03.21.07')
    expect(payload.upgradeCommand).toBe('semibot upgrade --manifest-url https://releases.semibot.ai/stable/latest.json')
    expect(payload.channel).toBe('stable')
  })

  it('does not mark update available when manifest version is the same', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        version: '2026.03.21.06',
        archive_url: 'https://releases.semibot.ai/stable/semibot-2026.03.21.06.tar.gz',
      }),
    }) as typeof fetch

    const payload = await resolveVersionPayload()

    expect(payload.latestVersion).toBe('2026.03.21.06')
    expect(payload.updateAvailable).toBe(false)
    expect(payload.upgradeCommand).toBe('semibot upgrade --manifest-url https://releases.semibot.ai/stable/latest.json')
  })
})
