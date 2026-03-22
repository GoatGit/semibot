import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isIP } from 'node:net'
import { type ChildProcess, spawn } from 'node:child_process'
import { compareReleaseVersions, resolveCurrentVersion } from './version'

export type UpgradeStatus =
  | 'idle'
  | 'queued'
  | 'stopping'
  | 'upgrading'
  | 'restarting'
  | 'succeeded'
  | 'failed'

export interface ReleaseUpgradePayload {
  status: UpgradeStatus
  manifestUrl: string | null
  targetVersion: string | null
  workerPid: number | null
  startedAt: string | null
  finishedAt: string | null
  message: string | null
  error: string | null
}

function isBlockedLiteralHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (!normalized) return true
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  const ipVersion = isIP(normalized)
  if (!ipVersion) return false
  if (ipVersion === 4) {
    if (normalized.startsWith('10.')) return true
    if (normalized.startsWith('127.')) return true
    if (normalized.startsWith('169.254.')) return true
    if (normalized.startsWith('192.168.')) return true
    const [first, second] = normalized.split('.').map(Number)
    if (first === 172 && second >= 16 && second <= 31) return true
    return false
  }

  const compact = normalized.replace(/:/g, '')
  return (
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    compact === ''
  )
}

export function validateUpgradeManifestUrl(rawUrl: string): string {
  const value = String(rawUrl || '').trim()
  if (!value) {
    throw new Error('manifest URL is required')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('manifest URL is invalid')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('manifest URL must use HTTPS')
  }
  if (isBlockedLiteralHost(parsed.hostname)) {
    throw new Error('manifest URL host is not allowed')
  }
  return parsed.toString()
}

function semibotHome(): string {
  return String(process.env.SEMIBOT_HOME || path.join(os.homedir(), '.semibot')).trim()
}

function upgradeStateFile(): string {
  return path.join(semibotHome(), 'run', 'upgrade-status.json')
}

function workerScriptPath(): string {
  const override = String(process.env.SEMIBOT_UPGRADE_WORKER_SCRIPT || '').trim()
  if (override) return override
  return path.resolve(process.cwd(), 'scripts', 'version-upgrade-worker.cjs')
}

function processAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function idlePayload(): ReleaseUpgradePayload {
  return {
    status: 'idle',
    manifestUrl: null,
    targetVersion: null,
    workerPid: null,
    startedAt: null,
    finishedAt: null,
    message: null,
    error: null,
  }
}

export function readUpgradeState(): ReleaseUpgradePayload {
  const target = upgradeStateFile()
  try {
    const payload = JSON.parse(fs.readFileSync(target, 'utf-8')) as Partial<ReleaseUpgradePayload>
    const normalized: ReleaseUpgradePayload = {
      ...idlePayload(),
      ...payload,
    }
    const currentVersion = resolveCurrentVersion()
    if (
      normalized.targetVersion &&
      ['succeeded', 'failed'].includes(normalized.status) &&
      compareReleaseVersions(currentVersion, normalized.targetVersion) >= 0
    ) {
      return idlePayload()
    }
    if (
      ['queued', 'stopping', 'upgrading', 'restarting'].includes(normalized.status) &&
      !processAlive(normalized.workerPid)
    ) {
      return {
        ...normalized,
        status: 'failed',
        finishedAt: normalized.finishedAt || new Date().toISOString(),
        message: normalized.message || '升级任务已终止',
        error: normalized.error || 'upgrade worker exited unexpectedly',
      }
    }
    return normalized
  } catch {
    return idlePayload()
  }
}

export function startBackgroundUpgrade(manifestUrl: string, targetVersion: string | null): ReleaseUpgradePayload {
  const normalizedManifestUrl = validateUpgradeManifestUrl(manifestUrl)
  const current = readUpgradeState()
  if (['queued', 'stopping', 'upgrading', 'restarting'].includes(current.status)) {
    throw new Error('已有升级任务正在运行')
  }

  const stateFile = upgradeStateFile()
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })

  const payload: ReleaseUpgradePayload = {
    status: 'queued',
    manifestUrl: normalizedManifestUrl,
    targetVersion,
    workerPid: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: '升级任务已提交',
    error: null,
  }
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2) + '\n', 'utf-8')

  const child = spawnDetachedUpgradeWorker(
    process.execPath,
    [workerScriptPath(), '--state-file', stateFile, '--manifest-url', normalizedManifestUrl, '--home', semibotHome()],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
      },
    }
  )
  child.unref()

  const runningPayload: ReleaseUpgradePayload = {
    ...payload,
    workerPid: child.pid ?? null,
  }
  fs.writeFileSync(stateFile, JSON.stringify(runningPayload, null, 2) + '\n', 'utf-8')
  return runningPayload
}

export function spawnDetachedUpgradeWorker(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  return spawn(command, args, options)
}
