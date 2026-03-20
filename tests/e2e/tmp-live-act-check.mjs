const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3001/api/v1').replace(/\/$/, '')
const TOKEN = process.env.E2E_TOKEN || 'no-auth-e2e'
const AGENT_ID = process.env.AGENT_ID || '00000000-0000-0000-0000-000000000001'
const PROMPT =
  process.env.E2E_PROMPT ||
  '搜索最新的 AI 行业动态，要求是中文动态，分门别类，并总结至少10条内容给我，同时给出引用链接，格式排版美观，内容不要堆叠在一起'

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...extra,
  }
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${url} failed: ${res.status} ${JSON.stringify(body).slice(0, 500)}`)
  }
  return body
}

async function createSession() {
  const body = await fetchJson(`${API_BASE}/sessions`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      agentId: AGENT_ID,
      title: `live-e2e-ai-news-${Date.now()}`,
      runtimeType: 'semigraph',
    }),
  })
  return body?.data?.id
}

async function sendMessageAndParseSSE(sessionId, message, timeoutMs = 420_000) {
  const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
    method: 'POST',
    headers: authHeaders({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`SSE request failed: ${res.status} ${text.slice(0, 1000)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const result = {
    hasDone: false,
    hasError: false,
    donePayload: null,
    errorPayload: null,
    files: [],
    events: [],
  }

  let buffer = ''
  const timer = setTimeout(() => {
    reader.cancel().catch(() => {})
  }, timeoutMs)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split('\n\n')
      buffer = blocks.pop() || ''

      for (const block of blocks) {
        if (!block.trim()) continue
        const eventLine = block.split('\n').find((line) => line.startsWith('event: '))
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
        if (!dataLine) continue
        const eventType = eventLine?.slice(7).trim() || 'message'
        let data = null
        try {
          data = JSON.parse(dataLine.slice(6))
        } catch {
          data = { raw: dataLine.slice(6) }
        }
        result.events.push({ eventType, data })
        if (eventType === 'file_created') {
          result.files.push(data?.data || data)
        }
        if (eventType === 'error') {
          result.hasError = true
          result.errorPayload = data
        }
        if (eventType === 'done' || eventType === 'execution_complete') {
          result.hasDone = true
          result.donePayload = data
          return result
        }
      }
    }
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }

  return result
}

async function getMessages(sessionId) {
  const body = await fetchJson(`${API_BASE}/sessions/${sessionId}/messages`, {
    headers: authHeaders(),
  })
  return Array.isArray(body?.data) ? body.data : []
}

async function getEvents(sessionId) {
  const body = await fetchJson(`${API_BASE}/events?page=1&limit=200&sessionId=${sessionId}`, {
    headers: authHeaders(),
  })
  return Array.isArray(body?.items) ? body.items : []
}

async function waitForAssistantMessage(sessionId, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await getMessages(sessionId)
    const assistantMessages = messages.filter((m) => m.role === 'assistant')
    if (assistantMessages.length > 0) {
      return { messages, assistantMessages }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  const messages = await getMessages(sessionId)
  return { messages, assistantMessages: messages.filter((m) => m.role === 'assistant') }
}

function summarizeEventCounts(events) {
  const counts = {}
  for (const evt of events) {
    const key = String(evt?.event_type || evt?.eventType || 'unknown')
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

async function main() {
  console.log(JSON.stringify({ apiBase: API_BASE, agentId: AGENT_ID, prompt: PROMPT }, null, 2))
  const sessionId = await createSession()
  console.log(JSON.stringify({ createdSessionId: sessionId }, null, 2))

  const sse = await sendMessageAndParseSSE(sessionId, PROMPT)
  console.log(
    JSON.stringify(
      {
        sseSummary: {
          hasDone: sse.hasDone,
          hasError: sse.hasError,
          files: sse.files.length,
          eventCount: sse.events.length,
          lastEvents: sse.events.slice(-8).map((evt) => evt.eventType),
        },
      },
      null,
      2,
    ),
  )

  const { messages, assistantMessages } = await waitForAssistantMessage(sessionId)
  const events = await getEvents(sessionId)
  const finalAssistant = assistantMessages.at(-1) || null

  console.log(
    JSON.stringify(
      {
        sessionId,
        final: {
          assistantCount: assistantMessages.length,
          finalAssistantPreview: String(finalAssistant?.content || '').slice(0, 1500),
          finalAssistantLength: String(finalAssistant?.content || '').length,
          hasArtifactLabel: String(finalAssistant?.content || '').includes('artifact_result_text'),
          fileCount: sse.files.length,
        },
        eventCounts: summarizeEventCounts(events),
        toolFailures: events
          .filter((evt) => evt.event_type === 'tool.exec.failed')
          .map((evt) => ({
            subject: evt.subject,
            payload: evt.payload,
          }))
          .slice(0, 10),
        recentEvents: events.slice(0, 20).map((evt) => ({
          event_type: evt.event_type,
          subject: evt.subject,
          payload: evt.payload,
        })),
        messageRoles: messages.map((m) => m.role),
      },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
