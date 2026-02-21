import { spawn } from 'node:child_process'
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
      const child = spawn('/bin/sh', ['-lc', this.command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let settled = false

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(
          new SdkProviderError(
            'SDK_COMMAND_TIMEOUT',
            `SDK command timed out after ${this.timeoutMs}ms`
          )
        )
      }, this.timeoutMs)

      child.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
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
          usage: parsed.usage ?? {},
        })
      })

      child.stdin.write(JSON.stringify(toSdkCommandInput(input)))
      child.stdin.end()
    })
  }
}

export function createSdkProvider(): OpenClawSdkProvider {
  const cmd = (process.env.OPENCLAW_SDK_CMD ?? '').trim()
  const timeoutMs = Math.max(500, Number(process.env.OPENCLAW_SDK_TIMEOUT_MS ?? 15000))
  if (cmd) {
    return new CommandSdkProvider(cmd, timeoutMs)
  }
  return new FallbackSdkProvider()
}
