#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

function resolveOpenClawConfigPath() {
  const fromEnv = String(process.env.OPENCLAW_CONFIG_PATH || '').trim()
  if (fromEnv) return fromEnv
  const home = String(process.env.HOME || '').trim()
  if (!home) return ''
  return join(home, '.openclaw', 'openclaw.json')
}

function ensureModelContextWindow() {
  const configPath = resolveOpenClawConfigPath()
  if (!configPath || !existsSync(configPath)) return
  let raw = ''
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return
  }

  let config = {}
  try {
    config = JSON.parse(raw || '{}')
  } catch {
    return
  }
  const provider = config?.models?.providers?.['custom-api-chatanywhere-tech']
  const models = provider?.models
  if (!Array.isArray(models)) return

  let changed = false
  for (const model of models) {
    if (!model || typeof model !== 'object') continue
    const id = String(model.id || '')
    if (id === 'deepseek-v3.2') {
      if (Number(model.contextWindow || 0) < 16000) {
        model.contextWindow = 128000
        changed = true
      }
      if (Number(model.maxTokens || 0) <= 4096) {
        model.maxTokens = 8192
        changed = true
      }
      if (!model.api) {
        model.api = 'openai-completions'
        changed = true
      }
    }
  }

  if (!changed) return
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
    process.stderr.write(`[openclaw-sdk-runner] patched model context in ${configPath}\n`)
  } catch {
    // ignore patch failure and let downstream error surface if any.
  }
}

function runAgent(message) {
  ensureModelContextWindow()
  const sessionId = `semibot-sdk-${randomUUID()}`
  const timeoutMs = Math.max(420000, Number(process.env.OPENCLAW_AGENT_TIMEOUT_MS || 0))
  const timeoutSeconds = Math.max(5, Math.ceil(timeoutMs / 1000))
  const finalMessage = `${String(message || '').trim()}\n\n[Execution note]\nWhen calling web_search, use search_lang='zh-hans' for Chinese queries (or 'en'). Never use 'zh'.\nIf user asks for a PDF/XLSX/CSV file, you must actually generate the file artifact and return it as attachment/media instead of plain text template.`
  return new Promise((resolve, reject) => {
    const child = spawn(
      'openclaw',
      ['agent', '--local', '--json', '--thinking', 'minimal', '--timeout', String(timeoutSeconds), '--session-id', sessionId, '--message', finalMessage],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    let stdout = ''
    let stderr = ''
    let sawBlockedFetch = false
    let blockedFetchCount = 0
    let sawBrowserRelayUnavailable = false
    let settled = false
    const startedAt = Date.now()
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const timer = setTimeout(() => {
      if (settled) return
      const elapsed = Date.now() - startedAt
      const stderrPreview = (stderr || '').trim().slice(0, 600)
      fail(new Error(`openclaw agent timeout after ${elapsed}ms (session=${sessionId}) ${stderrPreview}`.trim()))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      stderr += text
      process.stderr.write(`[openclaw-sdk-runner] ${text}`)
      const lower = text.toLowerCase()
      if (lower.includes('blocked url fetch') || lower.includes('private/internal/special-use ip address')) {
        sawBlockedFetch = true
        blockedFetchCount += 1
        // Fast-degrade when fetch is repeatedly blocked by policy to avoid long timeouts.
        if (blockedFetchCount >= 2 && !stdout.trim()) {
          fail(new Error(`OPENCLAW_BLOCKED_FETCH_POLICY session=${sessionId}`))
          return
        }
      }
      if (
        lower.includes("can't reach the openclaw browser control service") ||
        lower.includes('no tab is connected') ||
        lower.includes('chrome extension relay is running')
      ) {
        sawBrowserRelayUnavailable = true
      }
    })
    child.on('error', (err) => {
      fail(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        if (sawBlockedFetch) {
          reject(
            new Error(
              `openclaw finished with blocked URL fetches; try different sources or network/DNS settings (session=${sessionId})`
            )
          )
          return
        }
        if (sawBrowserRelayUnavailable) {
          reject(
            new Error(
              `openclaw browser relay unavailable; start gateway/browser relay and retry (session=${sessionId})`
            )
          )
          return
        }
        reject(new Error((stderr || stdout || `openclaw exited with code ${code} (session=${sessionId})`).trim()))
        return
      }
      resolve(stdout)
    })
  })
}

function inferFilename(url, fallbackName = 'attachment') {
  try {
    const u = new URL(String(url || ''))
    const path = decodeURIComponent(u.pathname || '')
    const name = path.split('/').filter(Boolean).pop()
    if (name) return name
  } catch {
    // ignore
  }
  return fallbackName
}

function normalizeMimeType(filename = '') {
  const lower = String(filename).toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (lower.endsWith('.csv')) return 'text/csv'
  return 'application/octet-stream'
}

function extractFileLinksFromText(text) {
  const content = String(text || '')
  if (!content) return []
  const regex = /(https?:\/\/[^\s<>"')]+?\.(?:pdf|xlsx|csv)(?:\?[^\s<>"')]*)?)/gi
  const found = []
  const seen = new Set()
  for (const match of content.matchAll(regex)) {
    const url = String(match[1] || '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    const filename = inferFilename(url, 'attachment')
    found.push({
      url,
      filename,
      mime_type: normalizeMimeType(filename),
    })
  }
  return found
}

function parseAgentOutput(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return { text: '', files: [] }

  const toOutput = (parsed) => {
    const texts = []
    const files = []
    const payloadArrays = []
    if (Array.isArray(parsed?.payloads)) payloadArrays.push(parsed.payloads)
    if (Array.isArray(parsed?.result?.payloads)) payloadArrays.push(parsed.result.payloads)
    for (const payloads of payloadArrays) {
      for (const item of payloads) {
        if (!item || typeof item !== 'object') continue
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (text) texts.push(text)
        const mediaUrl = typeof item.mediaUrl === 'string' ? item.mediaUrl.trim() : ''
        if (mediaUrl) {
          const filename =
            (typeof item.filename === 'string' && item.filename.trim()) ||
            inferFilename(mediaUrl, 'attachment')
          files.push({
            url: mediaUrl,
            filename,
            mime_type:
              (typeof item.mimeType === 'string' && item.mimeType.trim()) ||
              normalizeMimeType(filename),
          })
        }
      }
    }
    if (typeof parsed?.reply === 'string' && parsed.reply.trim()) texts.push(parsed.reply.trim())
    if (typeof parsed?.text === 'string' && parsed.text.trim()) texts.push(parsed.text.trim())
    if (typeof parsed?.message === 'string' && parsed.message.trim()) texts.push(parsed.message.trim())
    const text = texts.join('\n\n').trim()
    for (const linked of extractFileLinksFromText(text)) {
      if (!files.some((f) => f.url === linked.url)) {
        files.push(linked)
      }
    }
    return { text, files }
  }

  const tryExtract = (candidate) => {
    const t = String(candidate || '').trim()
    if (!t) return null
    try {
      const parsed = JSON.parse(t)
      return toOutput(parsed)
    } catch {
      return null
    }
  }

  // Case 1: pure JSON output.
  const direct = tryExtract(trimmed)
  if (direct && (direct.text || direct.files.length > 0)) return direct

  // Case 2: logs + JSON (common when SDK writes hints before payload).
  const firstBrace = trimmed.indexOf('{')
  if (firstBrace >= 0) {
    const mixed = tryExtract(trimmed.slice(firstBrace))
    if (mixed && (mixed.text || mixed.files.length > 0)) return mixed
  }

  // Case 3: take last non-empty line as fallback, avoid dumping huge JSON blobs.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (!last.startsWith('{') && !last.startsWith('[')) {
      return { text: last, files: extractFileLinksFromText(last) }
    }
  }

  return { text: trimmed, files: extractFileLinksFromText(trimmed) }
}

async function main() {
  const inputRaw = await readStdin()
  let payload = {}
  try {
    payload = JSON.parse(inputRaw || '{}')
  } catch {
    payload = {}
  }

  const message = String(payload?.message || '').trim()
  if (!message) {
    process.stdout.write(JSON.stringify({ text: 'Empty message', usage: { tokens_in: 1, tokens_out: 1 } }))
    return
  }

  const out = await runAgent(message)
  const parsed = parseAgentOutput(out)
  const text = parsed.text
  const usageIn = Math.max(1, message.length)
  const usageOut = Math.max(1, text.length)
  process.stdout.write(JSON.stringify({ text, files: parsed.files, usage: { tokens_in: usageIn, tokens_out: usageOut } }))
}

main().catch((err) => {
  const msg = String(err?.message || err)
  const lower = msg.toLowerCase()
  if (
    lower.includes('openclaw_blocked_fetch_policy') ||
    lower.includes('blocked url fetch') ||
    lower.includes('private/internal/special-use ip address')
  ) {
    const text =
      '当前执行环境的网络安全策略拦截了目标站点抓取（web_fetch）。已终止本轮自动抓取，建议改用允许访问的数据源/API，或先配置可用搜索服务后重试。'
    process.stdout.write(JSON.stringify({ text, usage: { tokens_in: 1, tokens_out: text.length } }))
    process.exit(0)
    return
  }
  if (lower.includes('openclaw agent timeout')) {
    const text =
      'OpenClaw 搜索执行超时。当前建议：1) 配置可用的搜索 API（如 Brave）2) 缩小查询范围后重试。'
    process.stdout.write(JSON.stringify({ text, usage: { tokens_in: 1, tokens_out: text.length } }))
    process.exit(0)
    return
  }
  process.stderr.write(msg)
  process.exit(1)
})
