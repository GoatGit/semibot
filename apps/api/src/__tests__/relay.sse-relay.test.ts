import { describe, expect, it, vi } from 'vitest'
import {
  registerSSEConnection,
  unregisterSSEConnection,
  forwardSSE,
  closeSessionConnections,
  hasSessionConnections,
} from '../relay/sse-relay'

describe('relay/sse-relay', () => {
  it('registers and forwards to multiple connections', () => {
    const sendA = vi.fn().mockReturnValue(true)
    const sendB = vi.fn().mockReturnValue(true)
    const closeA = vi.fn()
    const closeB = vi.fn()

    registerSSEConnection('a', 's1', sendA, closeA)
    registerSSEConnection('b', 's1', sendB, closeB)

    expect(hasSessionConnections('s1')).toBe(true)

    forwardSSE('s1', 'message', { x: 1 })

    expect(sendA).toHaveBeenCalledWith('message', { x: 1 })
    expect(sendB).toHaveBeenCalledWith('message', { x: 1 })

    unregisterSSEConnection('a')
    unregisterSSEConnection('b')
  })

  it('removes broken connection when send returns false', () => {
    const sendA = vi.fn().mockReturnValue(false)
    const closeA = vi.fn()

    registerSSEConnection('c', 's2', sendA, closeA)
    forwardSSE('s2', 'message', { y: 2 })

    expect(closeA).toHaveBeenCalled()
    expect(hasSessionConnections('s2')).toBe(false)
  })

  it('closes all session connections', () => {
    const sendA = vi.fn().mockReturnValue(true)
    const sendB = vi.fn().mockReturnValue(true)
    const closeA = vi.fn()
    const closeB = vi.fn()

    registerSSEConnection('d', 's3', sendA, closeA)
    registerSSEConnection('e', 's3', sendB, closeB)

    closeSessionConnections('s3')

    expect(closeA).toHaveBeenCalled()
    expect(closeB).toHaveBeenCalled()
    expect(hasSessionConnections('s3')).toBe(false)
  })
})
