export function isSingleUserMode(): boolean {
  const enableAuth = process.env.SEMIBOT_ENABLE_AUTH
  const disableAuth = process.env.SEMIBOT_DISABLE_AUTH

  if (enableAuth !== undefined) return enableAuth !== 'true'
  if (disableAuth !== undefined) return disableAuth !== 'false'
  return true
}

function extractCodes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const record = error as {
    code?: unknown
    message?: unknown
    errors?: unknown
    aggregateErrors?: unknown
  }
  const codes: string[] = []
  if (typeof record.code === 'string') codes.push(record.code)
  if (typeof record.message === 'string') codes.push(record.message)
  if (Array.isArray(record.errors)) {
    for (const item of record.errors) codes.push(...extractCodes(item))
  }
  if (Array.isArray(record.aggregateErrors)) {
    for (const item of record.aggregateErrors) codes.push(...extractCodes(item))
  }
  return codes
}

export function isDatabaseUnavailable(error: unknown): boolean {
  const haystack = extractCodes(error).join(' | ').toLowerCase()
  return (
    haystack.includes('econnrefused') ||
    haystack.includes('connect') ||
    haystack.includes('connection terminated') ||
    haystack.includes('database') ||
    haystack.includes('postgres')
  )
}
