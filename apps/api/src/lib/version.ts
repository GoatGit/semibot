import fs from 'node:fs'
import path from 'node:path'

export interface ReleaseVersionPayload {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  releaseUrl: string | null
  releaseNotesUrl: string | null
  manifestUrl: string | null
  upgradeCommand: string | null
  channel: string | null
  checkedAt: string | null
}

function parseReleaseVersion(value: string | null | undefined): number[] | null {
  const raw = String(value || '').trim()
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(raw)) return null
  return raw.split('.').map((part) => Number(part))
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left)
  const b = parseReleaseVersion(right)
  if (!a || !b) return left.localeCompare(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0)
    if (delta !== 0) return delta
  }
  return 0
}

function readPackageVersion(): string {
  try {
    const packageFile = path.resolve(process.cwd(), 'package.json')
    const payload = JSON.parse(fs.readFileSync(packageFile, 'utf-8'))
    return String(payload.version || 'dev')
  } catch {
    return 'dev'
  }
}

export function resolveCurrentVersion(): string {
  return String(process.env.SEMIBOT_RELEASE_VERSION || '').trim() || readPackageVersion()
}

export async function resolveVersionPayload(): Promise<ReleaseVersionPayload> {
  const currentVersion = resolveCurrentVersion()
  const manifestUrl = String(process.env.SEMIBOT_UPDATE_MANIFEST_URL || 'https://releases.semibot.ai/stable/latest.json').trim()
  if (!manifestUrl) {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotesUrl: null,
      manifestUrl: null,
      upgradeCommand: null,
      channel: null,
      checkedAt: null,
    }
  }

  try {
    const response = await fetch(manifestUrl, {
      headers: { 'User-Agent': 'semibot-api-version-check/1' },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      throw new Error(`http ${response.status}`)
    }
    const payload = await response.json() as Record<string, unknown>
    const latestVersion = String(payload.version || '').trim() || null
    return {
      currentVersion,
      latestVersion,
      updateAvailable: Boolean(latestVersion && compareReleaseVersions(latestVersion, currentVersion) > 0),
      releaseUrl: String(payload.archive_url || '').trim() || null,
      releaseNotesUrl: String(payload.release_notes_url || '').trim() || null,
      manifestUrl,
      upgradeCommand: `semibot upgrade --manifest-url ${manifestUrl}`,
      channel: String(payload.channel || '').trim() || null,
      checkedAt: new Date().toISOString(),
    }
  } catch {
    return {
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      releaseNotesUrl: null,
      manifestUrl,
      upgradeCommand: `semibot upgrade --manifest-url ${manifestUrl}`,
      channel: null,
      checkedAt: new Date().toISOString(),
    }
  }
}
