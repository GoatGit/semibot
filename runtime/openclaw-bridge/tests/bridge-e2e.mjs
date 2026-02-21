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
  const child = spawn('node', ['dist/main.js'], {
    cwd: bridgeRoot,
    env: { ...process.env, OPENCLAW_RUNNER_MODE: 'mock' },
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
        // ignore non-json
      }
    }
  }

  const stderr = []
  const onStderr = (chunk) => {
    stderr.push(chunk.toString('utf-8'))
  }

  child.stdout.on('data', onStdout)
  child.stderr.on('data', onStderr)

  return {
    lines,
    stderr,
    stop() {
      child.stdout.off('data', onStdout)
      child.stderr.off('data', onStderr)
    },
  }
}

async function waitFor(collector, predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate(collector.lines)) return
    await sleep(50)
  }
  throw new Error(`Timeout waiting for output.\nlines=${JSON.stringify(collector.lines)}\nstderr=${collector.stderr.join('')}`)
}

async function main() {
  const child = startBridge()
  const collector = createCollector(child)
  const sessionId = 'sess-e2e-1'

  child.stdin.write(
    `${JSON.stringify({
      type: 'start',
      session_id: sessionId,
      payload: { skill_index: [{ id: 'skill-1', version: 'latest' }] },
    })}\n`
  )

  await waitFor(collector, (lines) => lines.some((x) => x.type === 'cp_request' && x.method === 'get_skill_package'))
  const skillReq = collector.lines.find((x) => x.type === 'cp_request' && x.method === 'get_skill_package')
  assert(skillReq, 'expected get_skill_package request')

  child.stdin.write(
    `${JSON.stringify({
      type: 'cp_response',
      id: skillReq.id,
      result: {
        package: { skill_id: 'skill-1', version: 'latest', files: [] },
      },
    })}\n`
  )

  child.stdin.write(
    `${JSON.stringify({
      type: 'user_message',
      session_id: sessionId,
      payload: { message: 'hello memory' },
    })}\n`
  )

  await waitFor(collector, (lines) => lines.some((x) => x.type === 'cp_request' && x.method === 'memory_search'))
  const memoryReq = collector.lines.find((x) => x.type === 'cp_request' && x.method === 'memory_search')
  assert(memoryReq, 'expected memory_search request')

  child.stdin.write(
    `${JSON.stringify({
      type: 'cp_response',
      id: memoryReq.id,
      result: { results: [{ content: 'memo-hit' }] },
    })}\n`
  )

  await waitFor(
    collector,
    (lines) =>
      lines.some((x) => x.type === 'execution_complete') &&
      lines.some((x) => x.type === 'cp_fire_and_forget' && x.method === 'usage_report') &&
      lines.some((x) => x.type === 'cp_fire_and_forget' && x.method === 'audit_log')
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
