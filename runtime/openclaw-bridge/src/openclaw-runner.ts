import type { OpenClawEvent } from './event-translator.js'
import { SdkProviderError, createSdkProvider } from './sdk-provider.js'

type ControlPlaneRequestFn = (method: string, params: Record<string, unknown>) => Promise<unknown>
type ControlPlaneFireAndForgetFn = (method: string, params: Record<string, unknown>) => Promise<void>
type EmitEventFn = (event: OpenClawEvent) => void
type GetLoadedSkillCountFn = () => number

export interface OpenClawRunner {
  onStart(startPayload: Record<string, unknown>): Promise<void>
  onUserMessage(message: string): Promise<void>
  onConfigUpdate(payload: Record<string, unknown>): Promise<void>
  onCancel(): Promise<void>
  getSnapshot(): Record<string, unknown>
}

type RunnerDeps = {
  requestControlPlane: ControlPlaneRequestFn
  fireAndForget: ControlPlaneFireAndForgetFn
  emit: EmitEventFn
  getLoadedSkillCount: GetLoadedSkillCountFn
}

class MockOpenClawRunner implements OpenClawRunner {
  private lastMessage = ''
  private lastResponse = ''

  constructor(private readonly deps: RunnerDeps) {}

  async onStart(_startPayload: Record<string, unknown>): Promise<void> {
    this.deps.emit({
      kind: 'reasoning',
      text: 'OpenClaw runner initialized',
    })
  }

  async onUserMessage(message: string): Promise<void> {
    this.lastMessage = message
    this.deps.emit({
      kind: 'reasoning',
      text: 'OpenClaw bridge requesting control plane context...',
    })

    try {
      const result = (await this.deps.requestControlPlane('memory_search', {
        query: message,
        top_k: 3,
      })) as { results?: Array<{ content?: string }> }
      const firstMemory = result.results?.[0]?.content ?? 'No memory hit'
      const loadedSkillCount = this.deps.getLoadedSkillCount()
      const finalResponse = `OpenClaw mock response: ${firstMemory} (skills:${loadedSkillCount})`
      this.lastResponse = finalResponse

      this.deps.emit({
        kind: 'assistant_message',
        text: finalResponse,
      })

      await this.deps.fireAndForget('audit_log', {
        event: 'openclaw_mock_response',
        details: {
          memory_hit: firstMemory,
          loaded_skills: loadedSkillCount,
        },
      })
      await this.deps.fireAndForget('usage_report', {
        model: 'openclaw-mock',
        tokens_in: Math.max(1, message.length),
        tokens_out: Math.max(1, firstMemory.length),
      })

      this.deps.emit({
        kind: 'done',
        final_response: finalResponse,
      })
    } catch (error) {
      this.deps.emit({
        kind: 'error',
        error: String(error),
      })
    }
  }

  async onCancel(): Promise<void> {
    this.deps.emit({
      kind: 'error',
      error: 'Execution cancelled',
    })
  }

  async onConfigUpdate(_payload: Record<string, unknown>): Promise<void> {
    return
  }

  getSnapshot(): Record<string, unknown> {
    return {
      last_user_message: this.lastMessage,
      last_response: this.lastResponse,
      loaded_skill_count: this.deps.getLoadedSkillCount(),
      runner_mode: 'mock',
    }
  }
}

class SdkOpenClawRunner implements OpenClawRunner {
  private readonly sdk = createSdkProvider()
  private model = 'openclaw-sdk'
  private toolProfile = 'default'
  private lastMessage = ''
  private lastResponse = ''

  constructor(private readonly deps: RunnerDeps) {}

  async onStart(startPayload: Record<string, unknown>): Promise<void> {
    const openclawConfig = (startPayload.openclaw_config ?? {}) as Record<string, unknown>
    const agentConfig = (startPayload.agent_config ?? {}) as Record<string, unknown>

    if (typeof agentConfig.model === 'string' && agentConfig.model) {
      this.model = agentConfig.model
    }
    if (typeof openclawConfig.tool_profile === 'string' && openclawConfig.tool_profile) {
      this.toolProfile = openclawConfig.tool_profile
    }

    this.deps.emit({
      kind: 'reasoning',
      text: `OpenClaw SDK runner initializing (${this.toolProfile})...`,
    })
  }

  async onUserMessage(message: string): Promise<void> {
    this.lastMessage = message
    this.deps.emit({
      kind: 'reasoning',
      text: 'OpenClaw SDK runner retrieving memory context...',
    })

    try {
      const result = (await this.deps.requestControlPlane('memory_search', {
        query: message,
        top_k: 5,
      })) as { results?: Array<{ content?: string }> }

      const memoryContext = (result.results ?? [])
        .map((row) => String(row.content ?? '').trim())
        .filter((x) => x.length > 0)
        .slice(0, 5)

      this.deps.emit({
        kind: 'reasoning',
        text: 'OpenClaw SDK runner generating response...',
      })

      const generated = await this.sdk.generate({
        message,
        memoryContext,
        loadedSkillCount: this.deps.getLoadedSkillCount(),
        model: this.model,
        toolProfile: this.toolProfile,
      })

      const text = generated.text || 'OpenClaw SDK returned empty response'
      this.lastResponse = text
      this.deps.emit({
        kind: 'assistant_message',
        text,
      })

      await this.deps.fireAndForget('audit_log', {
        event: 'openclaw_sdk_response',
        details: {
          model: this.model,
          tool_profile: this.toolProfile,
          memory_hits: memoryContext.length,
        },
      })

      await this.deps.fireAndForget('usage_report', {
        model: this.model,
        tokens_in: Math.max(1, generated.usage?.tokens_in ?? message.length),
        tokens_out: Math.max(1, generated.usage?.tokens_out ?? text.length),
      })

      this.deps.emit({
        kind: 'done',
        final_response: text,
      })
    } catch (error) {
      const sdkError =
        error instanceof SdkProviderError
          ? error
          : (error &&
              typeof error === 'object' &&
              'name' in error &&
              (error as { name?: unknown }).name === 'SdkProviderError' &&
              'code' in error &&
              typeof (error as { code?: unknown }).code === 'string')
            ? ({
                code: (error as { code: string }).code,
                message: (error as { message?: string }).message ?? String(error),
              } as const)
            : null

      if (sdkError) {
        this.deps.emit({
          kind: 'error',
          error_code: sdkError.code,
          error: sdkError.message,
        })
        return
      }
      this.deps.emit({
        kind: 'error',
        error: String(error),
      })
    }
  }

  async onCancel(): Promise<void> {
    this.deps.emit({
      kind: 'error',
      error: 'Execution cancelled',
    })
  }

  async onConfigUpdate(payload: Record<string, unknown>): Promise<void> {
    const openclawConfig = (payload.openclaw_config ?? {}) as Record<string, unknown>
    const agentConfig = (payload.agent_config ?? {}) as Record<string, unknown>
    if (typeof agentConfig.model === 'string' && agentConfig.model) {
      this.model = agentConfig.model
    }
    if (typeof openclawConfig.tool_profile === 'string' && openclawConfig.tool_profile) {
      this.toolProfile = openclawConfig.tool_profile
    }
  }

  getSnapshot(): Record<string, unknown> {
    return {
      model: this.model,
      tool_profile: this.toolProfile,
      last_user_message: this.lastMessage,
      last_response: this.lastResponse,
      loaded_skill_count: this.deps.getLoadedSkillCount(),
      runner_mode: 'sdk',
    }
  }
}

export function createOpenClawRunner(deps: RunnerDeps): OpenClawRunner {
  const mode = process.env.OPENCLAW_RUNNER_MODE ?? 'mock'
  if (mode === 'sdk') {
    return new SdkOpenClawRunner(deps)
  }
  return new MockOpenClawRunner(deps)
}
