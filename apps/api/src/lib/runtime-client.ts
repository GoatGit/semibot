/**
 * Runtime HTTP client (single-machine mode).
 *
 * Persisted config (tools/mcp) is owned by runtime SQLite (~/.semibot/semibot.db).
 */

import { createLogger } from './logger'

const runtimeClientLogger = createLogger('runtime-client')

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function getRuntimeBaseUrls(): string[] {
  const fallbackUrls = ['http://localhost:8765', 'http://localhost:8901', 'http://localhost:8801']
  const configured = (process.env.RUNTIME_URL || '')
    .split(',')
    .map((value) => normalizeBaseUrl(value))
    .filter(Boolean)

  return Array.from(new Set([...configured, ...fallbackUrls]))
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${baseUrl}${normalizedPath}`)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue
      url.searchParams.set(key, String(value))
    }
  }

  return url.toString()
}

export async function runtimeRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: unknown
    query?: Record<string, string | number | boolean | undefined>
    timeoutMs?: number
  } = {}
): Promise<T> {
  const baseUrls = getRuntimeBaseUrls()
  const errors: string[] = []

  for (const baseUrl of baseUrls) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2000)

    try {
      const response = await fetch(buildUrl(baseUrl, path, options.query), {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        errors.push(`${baseUrl}: ${response.status} ${text || response.statusText}`)
        continue
      }

      return (await response.json()) as T
    } catch (error) {
      clearTimeout(timeout)
      errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const message = `Runtime unavailable for ${path}: ${errors.join('; ') || 'unknown error'}`
  runtimeClientLogger.error(message)
  throw new Error(message)
}
