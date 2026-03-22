import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readUpgradeState, startBackgroundUpgrade, validateUpgradeManifestUrl } from '../lib/version-upgrade'

describe('version upgrade state', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('returns idle state when no upgrade state file exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semibot-upgrade-'))
    process.env.SEMIBOT_HOME = home

    expect(readUpgradeState()).toMatchObject({
      status: 'idle',
      manifestUrl: null,
      workerPid: null,
    })
  })

  it('starts a detached background upgrade worker', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semibot-upgrade-'))
    process.env.SEMIBOT_HOME = home
    const workerScript = path.join(home, 'noop-worker.cjs')
    fs.writeFileSync(workerScript, 'setTimeout(() => process.exit(0), 1000)\n', 'utf-8')
    process.env.SEMIBOT_UPGRADE_WORKER_SCRIPT = workerScript

    vi.spyOn(process, 'kill').mockImplementation(() => true)

    const payload = startBackgroundUpgrade('https://releases.semibot.ai/stable/latest.json', '2026.03.21.20')

    expect(payload.status).toBe('queued')
    expect(typeof payload.workerPid).toBe('number')
    expect((payload.workerPid || 0) > 0).toBe(true)
    expect(readUpgradeState()).toMatchObject({
      status: 'queued',
      manifestUrl: 'https://releases.semibot.ai/stable/latest.json',
      targetVersion: '2026.03.21.20',
    })
  })

  it('rejects non-https and local manifest urls', () => {
    expect(() => validateUpgradeManifestUrl('http://releases.semibot.ai/stable/latest.json')).toThrow(
      'manifest URL must use HTTPS'
    )
    expect(() => validateUpgradeManifestUrl('https://127.0.0.1/latest.json')).toThrow(
      'manifest URL host is not allowed'
    )
    expect(() => validateUpgradeManifestUrl('https://localhost/latest.json')).toThrow(
      'manifest URL host is not allowed'
    )
    expect(() => validateUpgradeManifestUrl('https://192.168.1.10/latest.json')).toThrow(
      'manifest URL host is not allowed'
    )
  })

  it('clears stale terminal upgrade state after current version reaches target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'semibot-upgrade-'))
    process.env.SEMIBOT_HOME = home
    process.env.SEMIBOT_RELEASE_VERSION = '2026.03.22.05'
    const stateFile = path.join(home, 'run', 'upgrade-status.json')
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        status: 'failed',
        manifestUrl: 'https://releases.semibot.ai/stable/latest.json',
        targetVersion: '2026.03.22.04',
        workerPid: null,
        startedAt: '2026-03-22T00:00:00.000Z',
        finishedAt: '2026-03-22T00:01:00.000Z',
        message: '升级失败',
        error: 'old failure',
      }),
      'utf-8'
    )

    expect(readUpgradeState()).toMatchObject({
      status: 'idle',
      targetVersion: null,
      error: null,
    })
  })
})
