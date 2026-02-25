import type { OpenClawEvent } from './event-translator.js'
import { SdkProviderError, createSdkProvider } from './sdk-provider.js'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const GENERATED_FILES_DIR = path.resolve(process.env.GENERATED_FILES_DIR ?? '/tmp/semibot/generated-files')

function messageRequiresArtifact(message: string): boolean {
  const text = String(message || '').toLowerCase()
  return (
    text.includes('.pdf') ||
    text.includes('.xlsx') ||
    text.includes('.csv') ||
    text.includes('生成pdf') ||
    text.includes('生成 pdf') ||
    text.includes('生成表格') ||
    text.includes('download')
  )
}

function requestedArtifactType(message: string): 'pdf' | 'xlsx' | 'csv' | null {
  const text = String(message || '').toLowerCase()
  if (text.includes('pdf') || text.includes('生成pdf') || text.includes('生成 pdf')) return 'pdf'
  if (text.includes('xlsx') || text.includes('excel') || text.includes('表格')) return 'xlsx'
  if (text.includes('csv')) return 'csv'
  return null
}

function inferFilename(fileRef: string, fallback = 'artifact.bin'): string {
  const raw = String(fileRef || '').trim()
  if (!raw) return fallback
  try {
    const url = new URL(raw)
    const name = path.basename(decodeURIComponent(url.pathname || ''))
    return name || fallback
  } catch {
    const name = path.basename(raw)
    return name || fallback
  }
}

function inferMimeType(filename: string): string {
  const ext = path.extname(String(filename || '').toLowerCase())
  switch (ext) {
    case '.pdf':
      return 'application/pdf'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.csv':
      return 'text/csv'
    default:
      return 'application/octet-stream'
  }
}

function toLocalFilePath(fileRef: string): string | null {
  const raw = String(fileRef || '').trim()
  if (!raw) return null
  if (raw.startsWith('file://')) {
    try {
      return fileURLToPath(raw)
    } catch {
      return null
    }
  }
  if (raw.startsWith('/')) return raw
  if (/^[A-Za-z]:[\\/]/.test(raw)) return raw
  if (/^https?:\/\//i.test(raw)) return null
  return null
}

async function persistLocalArtifact(fileRef: string, preferredFilename?: string): Promise<{
  filename: string
  mime_type: string
  size: number
  url: string
}> {
  const source = toLocalFilePath(fileRef)
  if (!source) {
    throw new Error('not_a_local_file')
  }

  const fileId = randomUUID().replace(/-/g, '')
  const filename = preferredFilename || inferFilename(source)
  const safeFilename = filename.replace(/[\\/]/g, '_')
  const destDir = path.resolve(GENERATED_FILES_DIR, fileId)
  const destPath = path.resolve(destDir, safeFilename)
  await mkdir(destDir, { recursive: true })
  await copyFile(source, destPath)
  const st = await stat(destPath)
  return {
    filename: safeFilename,
    mime_type: inferMimeType(safeFilename),
    size: st.size,
    url: `/api/v1/files/${fileId}`,
  }
}

function escapePdfText(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function chunkLines(lines: string[], maxCharsPerLine = 80): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = String(raw ?? '')
    if (line.length <= maxCharsPerLine) {
      out.push(line)
      continue
    }
    let i = 0
    while (i < line.length) {
      out.push(line.slice(i, i + maxCharsPerLine))
      i += maxCharsPerLine
    }
  }
  return out
}

function buildSimplePdfBuffer(text: string): Buffer {
  const normalized = String(text || '').replace(/\r\n/g, '\n')
  const wrappedLines = chunkLines(normalized.split('\n'), 86)
  const lines = wrappedLines.length > 0 ? wrappedLines : ['(empty)']
  const linesPerPage = 42
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage))
  }

  const pageCount = pages.length
  const pageStartObj = 3
  const fontObj = pageStartObj + pageCount * 2
  const objects: string[] = []

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = Array.from({ length: pageCount }, (_, i) => `${pageStartObj + i * 2} 0 R`).join(' ')
  objects[2] = `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>`

  for (let i = 0; i < pageCount; i += 1) {
    const pageObj = pageStartObj + i * 2
    const contentObj = pageObj + 1
    const pageLines = pages[i]
    const contentLines = [
      'BT',
      '/F1 11 Tf',
      '50 760 Td',
      ...pageLines.map((line, idx) => `${idx === 0 ? '' : '0 -16 Td ' }(${escapePdfText(line)}) Tj`.trim()),
      'ET',
    ]
    const stream = `${contentLines.join('\n')}\n`
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
    objects[contentObj] = `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}endstream`
  }

  objects[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = [0]
  for (let i = 1; i <= fontObj; i += 1) {
    offsets[i] = Buffer.byteLength(pdf, 'utf8')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'utf8')
  pdf += `xref\n0 ${fontObj + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i <= fontObj; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${fontObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

async function persistGeneratedPdfFromText(
  text: string,
  preferredFilename = 'report.pdf'
): Promise<{ filename: string; mime_type: string; size: number; url: string }> {
  const fileId = randomUUID().replace(/-/g, '')
  const safeFilename = (preferredFilename || 'report.pdf').replace(/[\\/]/g, '_').replace(/\s+/g, '_')
  const filename = safeFilename.toLowerCase().endsWith('.pdf') ? safeFilename : `${safeFilename}.pdf`
  const destDir = path.resolve(GENERATED_FILES_DIR, fileId)
  const destPath = path.resolve(destDir, filename)
  await mkdir(destDir, { recursive: true })
  const pdfBuffer = buildSimplePdfBuffer(text)
  await writeFile(destPath, pdfBuffer)
  const st = await stat(destPath)
  return {
    filename,
    mime_type: 'application/pdf',
    size: st.size,
    url: `/api/v1/files/${fileId}`,
  }
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

      const sdkStartedAt = Date.now()
      const heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - sdkStartedAt) / 1000))
        this.deps.emit({
          kind: 'reasoning',
          text: `OpenClaw SDK runner executing... (${elapsedSec}s)`,
        })
      }, 8000)

      const generated = await this.sdk.generate({
        message,
        memoryContext,
        loadedSkillCount: this.deps.getLoadedSkillCount(),
        model: this.model,
        toolProfile: this.toolProfile,
      }).finally(() => {
        clearInterval(heartbeat)
      })

      const final = generated

      const text = final.text || 'OpenClaw SDK returned empty response'
      this.lastResponse = text

      for (const file of final.files ?? []) {
        let emitted = {
          filename: file.filename ?? 'file',
          mime_type: file.mime_type ?? 'application/octet-stream',
          size: file.size,
          url: file.url,
        }
        try {
          const persisted = await persistLocalArtifact(file.url, file.filename)
          emitted = persisted
        } catch {
          // Non-local URLs are emitted as-is.
        }
        this.deps.emit({
          kind: 'file_created',
          filename: emitted.filename,
          mime_type: emitted.mime_type,
          size: emitted.size,
          url: emitted.url,
        })
      }

      this.deps.emit({
        kind: 'assistant_message',
        text,
      })

      if (messageRequiresArtifact(message) && (final.files ?? []).length === 0) {
        const requested = requestedArtifactType(message)
        if (requested === 'pdf' && text.trim()) {
          const fallback = await persistGeneratedPdfFromText(text, 'openclaw_report.pdf')
          this.deps.emit({
            kind: 'file_created',
            filename: fallback.filename,
            mime_type: fallback.mime_type,
            size: fallback.size,
            url: fallback.url,
          })
        } else {
          this.deps.emit({
            kind: 'error',
            error_code: 'OPENCLAW_ARTIFACT_MISSING',
            error: 'OpenClaw did not return a downloadable file artifact for this request.',
          })
          return
        }
      }

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
        tokens_in: Math.max(1, final.usage?.tokens_in ?? message.length),
        tokens_out: Math.max(1, final.usage?.tokens_out ?? text.length),
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
  const mode = process.env.OPENCLAW_RUNNER_MODE ?? 'sdk'
  if (mode === 'sdk') {
    return new SdkOpenClawRunner(deps)
  }
  return new MockOpenClawRunner(deps)
}
