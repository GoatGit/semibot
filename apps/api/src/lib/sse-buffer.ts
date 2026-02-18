/**
 * SSE 消息缓冲
 *
 * 支持断线重连后消息重放
 * - 每个 session 维护有界消息缓冲（最近 100 条）
 * - 每条消息携带递增 eventId
 * - 客户端重连时通过 Last-Event-ID 重放丢失的消息
 */

const SSE_BUFFER_MAX_SIZE = 100

interface BufferedMessage {
  eventId: number
  event: string
  data: string
}

// sessionId -> 消息缓冲
const sessionBuffers = new Map<string, {
  messages: BufferedMessage[]
  nextEventId: number
}>()

/**
 * 获取或创建 session 缓冲
 */
function getBuffer(sessionId: string) {
  let buffer = sessionBuffers.get(sessionId)
  if (!buffer) {
    buffer = { messages: [], nextEventId: 1 }
    sessionBuffers.set(sessionId, buffer)
  }
  return buffer
}

/**
 * 写入消息到缓冲并返回 eventId
 */
export function pushMessage(sessionId: string, event: string, data: unknown): number {
  const buffer = getBuffer(sessionId)
  const eventId = buffer.nextEventId++
  const dataStr = JSON.stringify(data)

  buffer.messages.push({ eventId, event, data: dataStr })

  // 超出上限，丢弃最旧消息
  if (buffer.messages.length > SSE_BUFFER_MAX_SIZE) {
    buffer.messages.shift()
  }

  return eventId
}

/**
 * 获取 lastEventId 之后的所有消息（用于重放）
 */
export function getMessagesSince(sessionId: string, lastEventId: number): BufferedMessage[] {
  const buffer = sessionBuffers.get(sessionId)
  if (!buffer) return []

  return buffer.messages.filter((msg) => msg.eventId > lastEventId)
}

/**
 * 清理 session 缓冲
 */
export function clearBuffer(sessionId: string): void {
  sessionBuffers.delete(sessionId)
}

/**
 * 获取缓冲大小（用于测试）
 */
export function getBufferSize(sessionId: string): number {
  return sessionBuffers.get(sessionId)?.messages.length ?? 0
}

/**
 * 获取下一个 eventId（用于测试）
 */
export function getNextEventId(sessionId: string): number {
  return sessionBuffers.get(sessionId)?.nextEventId ?? 1
}

export default {
  pushMessage,
  getMessagesSince,
  clearBuffer,
  getBufferSize,
  getNextEventId,
}
