/**
 * Queue 服务
 *
 * 使用 Redis Stream 实现任务队列
 */

import * as redis from '../lib/redis'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ChatTask {
  id: string
  orgId: string
  userId: string
  sessionId: string
  agentId: string
  message: string
  parentMessageId?: string
  createdAt: string
}

export interface TaskResult {
  taskId: string
  status: 'success' | 'error'
  data?: unknown
  error?: string
}

// ═══════════════════════════════════════════════════════════════
// 队列常量
// ═══════════════════════════════════════════════════════════════

export const CHAT_QUEUE_NAME = 'semibot:chat:queue'
export const CHAT_RESULT_PREFIX = 'semibot:chat:result:'
export const CONSUMER_GROUP = 'chat-workers'
export const CONSUMER_NAME = 'worker-1'
export const RESULT_TTL_SECONDS = 300

// ═══════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════

let isInitialized = false

/**
 * 初始化队列 (创建消费者组)
 */
export async function initializeQueue(): Promise<void> {
  if (isInitialized) return

  try {
    await redis.createConsumerGroup(CHAT_QUEUE_NAME, CONSUMER_GROUP)
    isInitialized = true
    console.log('[Queue] 队列初始化完成')
  } catch (error) {
    console.error('[Queue] 队列初始化失败:', error)
  }
}

// ═══════════════════════════════════════════════════════════════
// 队列服务方法
// ═══════════════════════════════════════════════════════════════

/**
 * 将任务推入队列
 */
export async function enqueueTask(task: ChatTask): Promise<string> {
  console.log(`[Queue] 任务入队 - ID: ${task.id}, Session: ${task.sessionId}`)

  try {
    const messageId = await redis.xadd(CHAT_QUEUE_NAME, {
      task: JSON.stringify(task),
    })

    console.log(`[Queue] 任务已入队 - MessageID: ${messageId}`)
    return messageId
  } catch (error) {
    console.error('[Queue] 任务入队失败:', error)
    throw error
  }
}

/**
 * 从队列中获取任务
 */
export async function dequeueTask(
  blockMs: number = 5000
): Promise<{ messageId: string; task: ChatTask } | null> {
  console.log('[Queue] 尝试获取任务...')

  try {
    // 确保队列已初始化
    await initializeQueue()

    const messages = await redis.xreadgroup(
      CONSUMER_GROUP,
      CONSUMER_NAME,
      CHAT_QUEUE_NAME,
      1,
      blockMs
    )

    if (!messages || messages.length === 0) {
      return null
    }

    const { id, fields } = messages[0]
    const task = JSON.parse(fields.task) as ChatTask

    console.log(`[Queue] 获取到任务 - MessageID: ${id}, TaskID: ${task.id}`)
    return { messageId: id, task }
  } catch (error) {
    console.error('[Queue] 获取任务失败:', error)
    return null
  }
}

/**
 * 确认任务完成
 */
export async function acknowledgeTask(messageId: string): Promise<void> {
  console.log(`[Queue] 确认任务 - MessageID: ${messageId}`)

  try {
    const ackCount = await redis.xack(CHAT_QUEUE_NAME, CONSUMER_GROUP, messageId)
    console.log(`[Queue] 任务已确认 - MessageID: ${messageId}, AckCount: ${ackCount}`)
  } catch (error) {
    console.error('[Queue] 确认任务失败:', error)
    throw error
  }
}

/**
 * 发布任务结果
 */
export async function publishResult(taskId: string, result: TaskResult): Promise<void> {
  console.log(`[Queue] 发布结果 - Task: ${taskId}, Status: ${result.status}`)

  try {
    const resultKey = `${CHAT_RESULT_PREFIX}${taskId}`
    await redis.setWithExpiry(resultKey, JSON.stringify(result), RESULT_TTL_SECONDS)

    // 同时发布到 Pub/Sub 频道，以便实时通知
    await redis.publish(`semibot:chat:result`, JSON.stringify(result))

    console.log(`[Queue] 结果已发布 - Key: ${resultKey}`)
  } catch (error) {
    console.error('[Queue] 发布结果失败:', error)
    throw error
  }
}

/**
 * 获取任务结果
 */
export async function getResult(taskId: string): Promise<TaskResult | null> {
  try {
    const resultKey = `${CHAT_RESULT_PREFIX}${taskId}`
    const resultStr = await redis.get(resultKey)

    if (!resultStr) {
      return null
    }

    return JSON.parse(resultStr) as TaskResult
  } catch (error) {
    console.error('[Queue] 获取结果失败:', error)
    return null
  }
}

/**
 * 获取队列长度
 */
export async function getQueueLength(): Promise<number> {
  try {
    const length = await redis.xlen(CHAT_QUEUE_NAME)
    console.log(`[Queue] 队列长度: ${length}`)
    return length
  } catch (error) {
    console.error('[Queue] 获取队列长度失败:', error)
    return 0
  }
}

/**
 * 健康检查
 */
export async function checkQueueHealth(): Promise<boolean> {
  try {
    const isHealthy = await redis.pingRedis()
    console.log(`[Queue] 健康检查 - 状态: ${isHealthy ? '正常' : '异常'}`)
    return isHealthy
  } catch (error) {
    console.error('[Queue] 健康检查失败:', error)
    return false
  }
}
