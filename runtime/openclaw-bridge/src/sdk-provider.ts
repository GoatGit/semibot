import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSdkCommandOutput, toSdkCommandInput } from './protocol.js'

export type SdkGenerateInput = {
  message: string
  memoryContext: string[]
  loadedSkillCount: number
  model?: string
  toolProfile?: string
}

export type SdkGenerateOutput = {
  text: string
  files?: Array<{
    url: string
    filename?: string
    mime_type?: string
    size?: number
  }>
  usage?: {
    tokens_in?: number
    tokens_out?: number
  }
}

export interface OpenClawSdkProvider {
  generate(input: SdkGenerateInput): Promise<SdkGenerateOutput>
}

export class SdkProviderError extends Error {
  constructor(
    public readonly code:
      | 'SDK_COMMAND_SPAWN_FAILED'
      | 'SDK_COMMAND_TIMEOUT'
      | 'SDK_COMMAND_FAILED'
      | 'SDK_OUTPUT_INVALID',
    message: string
  ) {
    super(message)
    this.name = 'SdkProviderError'
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function looksLikeInstallCommand(cmd: string): boolean {
  const normalized = cmd.trim().toLowerCase()
  if (!normalized) return false
  return (
    /\b(?:pnpm|npm|yarn|bun)\s+(?:add|install)\b/.test(normalized) ||
    /\bbrew\s+install\b/.test(normalized)
  )
}

function resolveBundledSdkCommand(): string | null {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const runner = resolve(currentDir, '../scripts/openclaw-sdk-runner.mjs')
  if (!existsSync(runner)) return null
  return `node ${shellQuote(runner)}`
}

class FallbackSdkProvider implements OpenClawSdkProvider {
  async generate(input: SdkGenerateInput): Promise<SdkGenerateOutput> {
    const firstMemory = input.memoryContext[0] ?? 'No memory hit'
    return {
      text: `OpenClaw SDK placeholder: ${firstMemory} (skills:${input.loadedSkillCount})`,
      usage: {
        tokens_in: Math.max(1, input.message.length),
        tokens_out: Math.max(1, firstMemory.length),
      },
    }
  }
}

class CommandSdkProvider implements OpenClawSdkProvider {
  constructor(
    private readonly command: string,
    private readonly timeoutMs: number
  ) {}

  async generate(input: SdkGenerateInput): Promise<SdkGenerateOutput> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now()
      const child = spawn('/bin/sh', ['-lc', this.command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      const commandLabel = this.command.length > 180 ? `${this.command.slice(0, 180)}...` : this.command

      // Diagnostic logs are intentionally lightweight and only emitted for SDK command lifecycle.
      console.error(`[openclaw-sdk] start timeoutMs=${this.timeoutMs} cmd=${commandLabel}`)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const elapsed = Date.now() - startedAt
        child.kill('SIGKILL')
        const stdoutPreview = stdout.trim().slice(0, 300)
        const stderrPreview = stderr.trim().slice(0, 300)
        console.error(
          `[openclaw-sdk] timeout elapsedMs=${elapsed} stdoutPreview=${JSON.stringify(stdoutPreview)} stderrPreview=${JSON.stringify(stderrPreview)}`
        )
        reject(
          new SdkProviderError(
            'SDK_COMMAND_TIMEOUT',
            `SDK command timed out after ${this.timeoutMs}ms (elapsed=${elapsed}ms)`
          )
        )
      }, this.timeoutMs)

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const elapsed = Date.now() - startedAt
        console.error(`[openclaw-sdk] spawn_error elapsedMs=${elapsed} err=${String(err)}`)
        reject(
          new SdkProviderError(
            'SDK_COMMAND_SPAWN_FAILED',
            `Failed to spawn SDK command: ${String(err)}`
          )
        )
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const elapsed = Date.now() - startedAt
        console.error(`[openclaw-sdk] close elapsedMs=${elapsed} code=${String(code)}`)
        if (code !== 0) {
          reject(
            new SdkProviderError(
              'SDK_COMMAND_FAILED',
              `SDK command failed (code=${code}): ${stderr || stdout}`.trim()
            )
          )
          return
        }
        const parsed = parseSdkCommandOutput(stdout || '')
        if (!parsed.text || !parsed.text.trim()) {
          reject(
            new SdkProviderError(
              'SDK_OUTPUT_INVALID',
              'SDK command returned empty output'
            )
          )
          return
        }
        resolve({
          text: String(parsed.text ?? '').trim(),
          files: parsed.files ?? [],
          usage: parsed.usage ?? {},
        })
      })

      child.stdin.write(JSON.stringify(toSdkCommandInput(input)))
      child.stdin.end()
    })
  }
}

export function createSdkProvider(): OpenClawSdkProvider {
  const envCmd = (process.env.OPENCLAW_SDK_CMD ?? '').trim()
  // Keep SDK command timeout >= agent timeout + safety buffer.
  const agentTimeoutMs = Math.max(600000, Number(process.env.OPENCLAW_AGENT_TIMEOUT_MS ?? 600000))
  const sdkTimeoutMs = Math.max(600000, Number(process.env.OPENCLAW_SDK_TIMEOUT_MS ?? 600000))
  const timeoutMs = Math.max(sdkTimeoutMs, agentTimeoutMs + 60000)
  if (envCmd && !looksLikeInstallCommand(envCmd)) {
    return new CommandSdkProvider(envCmd, timeoutMs)
  }

  const bundledCmd = resolveBundledSdkCommand()
  if (bundledCmd) {
    return new CommandSdkProvider(bundledCmd, timeoutMs)
  }
  return new FallbackSdkProvider()
}
