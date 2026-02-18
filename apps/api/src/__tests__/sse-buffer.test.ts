import { describe, it, expect, beforeEach } from 'vitest'
import { pushMessage, getMessagesSince, clearBuffer, getBufferSize, getNextEventId } from '../lib/sse-buffer'

describe('SSE Buffer', () => {
  const sessionId = 'test-session-001'

  beforeEach(() => {
    clearBuffer(sessionId)
  })

  describe('pushMessage', () => {
    it('should write message and return incrementing eventId', () => {
      const id1 = pushMessage(sessionId, 'message', { text: 'hello' })
      const id2 = pushMessage(sessionId, 'message', { text: 'world' })

      expect(id1).toBe(1)
      expect(id2).toBe(2)
      expect(getBufferSize(sessionId)).toBe(2)
    })

    it('should serialize data as JSON string', () => {
      pushMessage(sessionId, 'message', { key: 'value' })
      const messages = getMessagesSince(sessionId, 0)

      expect(messages[0].data).toBe('{"key":"value"}')
    })
  })

  describe('getMessagesSince', () => {
    it('should return messages after lastEventId', () => {
      pushMessage(sessionId, 'message', { text: '1' })
      pushMessage(sessionId, 'message', { text: '2' })
      pushMessage(sessionId, 'message', { text: '3' })

      const messages = getMessagesSince(sessionId, 1)

      expect(messages).toHaveLength(2)
      expect(messages[0].eventId).toBe(2)
      expect(messages[1].eventId).toBe(3)
    })

    it('should return empty array for unknown session', () => {
      const messages = getMessagesSince('unknown-session', 0)
      expect(messages).toEqual([])
    })

    it('should return all messages when lastEventId is 0', () => {
      pushMessage(sessionId, 'a', {})
      pushMessage(sessionId, 'b', {})

      const messages = getMessagesSince(sessionId, 0)
      expect(messages).toHaveLength(2)
    })

    it('should return empty when lastEventId is latest', () => {
      pushMessage(sessionId, 'message', {})
      pushMessage(sessionId, 'message', {})

      const messages = getMessagesSince(sessionId, 2)
      expect(messages).toHaveLength(0)
    })
  })

  describe('buffer overflow', () => {
    it('should discard oldest messages when exceeding max size', () => {
      // 写入 105 条消息
      for (let i = 1; i <= 105; i++) {
        pushMessage(sessionId, 'message', { index: i })
      }

      expect(getBufferSize(sessionId)).toBe(100)

      // 最旧的 5 条应该被丢弃
      const messages = getMessagesSince(sessionId, 0)
      expect(messages[0].eventId).toBe(6)
      expect(messages[messages.length - 1].eventId).toBe(105)
    })
  })

  describe('clearBuffer', () => {
    it('should remove all messages for session', () => {
      pushMessage(sessionId, 'message', {})
      pushMessage(sessionId, 'message', {})

      clearBuffer(sessionId)

      expect(getBufferSize(sessionId)).toBe(0)
      expect(getMessagesSince(sessionId, 0)).toEqual([])
    })
  })

  describe('getNextEventId', () => {
    it('should return 1 for new session', () => {
      expect(getNextEventId('new-session')).toBe(1)
    })

    it('should return next id after pushes', () => {
      pushMessage(sessionId, 'message', {})
      pushMessage(sessionId, 'message', {})

      expect(getNextEventId(sessionId)).toBe(3)
    })
  })
})
