import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

import { toSemibotSSE, translateOpenClawEvent } from './event-translator.js'
import { createOpenClawRunner } from './openclaw-runner.js'
import { parseBridgeCommand } from './protocol.js'
import { SkillLoader, type SkillPackage } from './skill-loader.js'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type SessionRuntime = {
  runner: ReturnType<typeof createOpenClawRunner>
  skillLoader: SkillLoader
}

function writeJSON(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

export function startBridgeLoop(): void {
  const pendingRequests = new Map<string, PendingRequest>()
  const sessions = new Map<string, SessionRuntime>()

  const requestControlPlane = (sessionId: string, method: string, params: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = randomUUID()
      pendingRequests.set(id, { resolve, reject })
      writeJSON({
        type: 'cp_request',
        id,
        session_id: sessionId,
        method,
        params,
      })
    })

  const fireAndForget = async (sessionId: string, method: string, params: Record<string, unknown>): Promise<void> => {
    writeJSON({
      type: 'cp_fire_and_forget',
      session_id: sessionId,
      method,
      params,
    })
  }

  const ensureSession = (sessionId: string): SessionRuntime => {
    const existing = sessions.get(sessionId)
    if (existing) return existing

    const skillLoader = new SkillLoader()
    const runner = createOpenClawRunner({
      requestControlPlane: (method, params) => requestControlPlane(sessionId, method, params),
      fireAndForget: (method, params) => fireAndForget(sessionId, method, params),
      emit: (event) => {
        const translated = translateOpenClawEvent(event)
        if (translated) writeJSON(translated)
      },
      getLoadedSkillCount: () => skillLoader.loadedCount(),
    })
    const runtime = { runner, skillLoader }
    sessions.set(sessionId, runtime)
    return runtime
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  const handleLine = async (line: string): Promise<void> => {
    const cmd = parseBridgeCommand(line)
    if (!cmd) return

    const sessionId = cmd.session_id ?? ''
    if (!sessionId && cmd.type !== 'stop' && cmd.type !== 'cp_response') {
      return
    }

    if (cmd.type === 'start') {
      const runtime = ensureSession(sessionId)
      runtime.skillLoader.hydrateFromIndex(cmd.payload?.skill_index)
      await runtime.runner.onStart(cmd.payload ?? {})

      const toLoad = runtime.skillLoader.nextRequiredSkill()
      if (toLoad) {
        const response = (await requestControlPlane(sessionId, 'get_skill_package', {
          skill_id: toLoad.id,
          version: toLoad.version ?? 'latest',
        })) as { package?: SkillPackage }
        if (response.package?.skill_id) {
          runtime.skillLoader.markLoaded(response.package)
          writeJSON({
            type: 'thinking',
            content: `Loaded skill package: ${response.package.skill_id}`,
            stage: 'planning',
          })
        }
      }
      return
    }

    if (cmd.type === 'user_message') {
      const runtime = ensureSession(sessionId)
      const text = String(cmd.payload?.message ?? '')
      await runtime.runner.onUserMessage(text)
      return
    }

    if (cmd.type === 'config_update') {
      const runtime = ensureSession(sessionId)
      await runtime.runner.onConfigUpdate(cmd.payload ?? {})
      return
    }

    if (cmd.type === 'snapshot') {
      const runtime = sessions.get(sessionId)
      writeJSON({
        type: 'snapshot_response',
        id: cmd.id ?? '',
        session_id: sessionId,
        snapshot: runtime?.runner.getSnapshot() ?? {},
      })
      return
    }

    if (cmd.type === 'cp_response') {
      const id = cmd.id ?? ''
      const pending = pendingRequests.get(id)
      if (!pending) return
      pendingRequests.delete(id)

      if (cmd.error) {
        pending.reject(new Error(String(cmd.error.message ?? cmd.error.code ?? 'cp request failed')))
      } else {
        pending.resolve(cmd.result ?? null)
      }
      return
    }

    if (cmd.type === 'cancel') {
      const runtime = sessions.get(sessionId)
      if (runtime) {
        await runtime.runner.onCancel()
      } else {
        const translated = toSemibotSSE({
          type: 'execution_error',
          code: 'EXECUTION_CANCELLED',
          error: 'Execution cancelled',
        })
        if (translated) writeJSON(translated)
      }
      return
    }

    if (cmd.type === 'stop') {
      rl.close()
      process.exit(0)
    }
  }

  rl.on('line', (line: string) => {
    void handleLine(line).catch((error: unknown) => {
      const translated = toSemibotSSE({
        type: 'execution_error',
        code: 'OPENCLAW_BRIDGE_INTERNAL_ERROR',
        error: String(error),
      })
      if (translated) writeJSON(translated)
    })
  })
}
