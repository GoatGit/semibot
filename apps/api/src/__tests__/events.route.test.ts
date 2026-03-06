import { describe, expect, it } from 'vitest'

import { isUuidSessionId, normalizeEventTimestamp } from '../routes/v1/events'

describe('events route session id guard', () => {
  it('accepts uuid session ids for message-derived fallback', () => {
    expect(isUuidSessionId('61cf7a0a-6457-494b-822d-6bb3cfd7f5fc')).toBe(true)
  })

  it('rejects placeholder route segments such as new', () => {
    expect(isUuidSessionId('new')).toBe(false)
    expect(isUuidSessionId('')).toBe(false)
    expect(isUuidSessionId(null)).toBe(false)
  })

  it('normalizes non-string timestamps before event sorting', () => {
    const date = new Date('2026-03-06T15:42:51.172Z')
    expect(normalizeEventTimestamp(date)).toBe('2026-03-06T15:42:51.172Z')
    expect(normalizeEventTimestamp(date.getTime())).toBe('2026-03-06T15:42:51.172Z')
    expect(typeof normalizeEventTimestamp('2026-03-06T15:42:51.172Z')).toBe('string')
  })
})
