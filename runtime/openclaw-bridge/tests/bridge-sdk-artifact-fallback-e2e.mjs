import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function startBridge() {
  const thisDir = path.dirname(fileURLToPath(import.meta.url))
  const bridgeRoot = path.resolve(thisDir, '..')
  const sdkCmd =
    `node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{` +
    `process.stdout.write(JSON.stringify({text:'timeout fallback text without files',files:[],usage:{tokens_in:3,tokens_out:5}}));` +
    `});"`

  const child = spawn('node', ['dist/main.js'], {
    cwd: bridgeRoot,
    env: {
      ...process.env,
      OPENCLAW_RUNNER_MODE: 'sdk',
      OPENCLAW_SDK_CMD: sdkCmd,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}

function createCollector(child) {
  const lines = []
  let buffer = ''

  const onStdout = (chunk) => {
    buffer += chunk.toString('utf-8')
    while (true) {
      const idx = buffer.indexOf('\n')
      if (idx < 0) break
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!raw) continue
      try {
        lines.push(JSON.parse(raw))
      } catch {
        // ignore
      }
    }
  }

  child.stdout.on('data', onStdout)

  return {
    lines,
    stop() {
      child.stdout.off('data', onStdout)
    },
  }
}

async function waitFor(collector, predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate(collector.lines)) return
    await sleep(50)
  }
  throw new Error(`Timeout waiting for output.\nlines=${JSON.stringify(collector.lines)}`)
}

async function main() {
  const child = startBridge()
  const collector = createCollector(child)
  const sessionId = 'sess-sdk-fallback-pdf-1'

  child.stdin.write(
    `${JSON.stringify({
      type: 'start',
      session_id: sessionId,
      payload: {
        agent_config: { model: 'deepseek-v3.2' },
        openclaw_config: { tool_profile: 'default' },
      },
    })}\n`
  )

  child.stdin.write(
    `${JSON.stringify({
      type: 'user_message',
      session_id: sessionId,
      payload: { message: '研究阿里巴巴股票，并生成PDF文件' },
    })}\n`
  )

  await waitFor(collector, (lines) => lines.some((x) => x.type === 'cp_request' && x.method === 'memory_search'))
  const memoryReq = collector.lines.find((x) => x.type === 'cp_request' && x.method === 'memory_search')
  assert(memoryReq, 'expected memory_search request')

  child.stdin.write(
    `${JSON.stringify({
      type: 'cp_response',
      id: memoryReq.id,
      result: { results: [] },
    })}\n`
  )

  await waitFor(
    collector,
    (lines) =>
      lines.some((x) => x.type === 'execution_complete') &&
      lines.some((x) => x.type === 'file_created')
  )

  assert(
    collector.lines.some(
      (x) =>
        x.type === 'file_created' &&
        typeof x.url === 'string' &&
        x.url.startsWith('/api/v1/files/') &&
        String(x.filename || '').toLowerCase().endsWith('.pdf')
    ),
    'expected generated fallback PDF file_created output'
  )

  child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`)
  await sleep(80)
  collector.stop()
  child.kill('SIGTERM')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

