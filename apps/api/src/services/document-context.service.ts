import crypto from 'crypto'
import os from 'os'
import path from 'path'
import fs from 'fs-extra'

const DEFAULT_ATTACH_TOTAL_BUDGET_CHARS = 30000
const DEFAULT_ATTACH_CHUNK_SIZE_CHARS = 1200
const DEFAULT_ATTACH_CHUNK_OVERLAP_CHARS = 120
const DEFAULT_ATTACH_MAX_CHUNK_CATALOG_ITEMS = 40
const DEFAULT_ATTACH_SMALL_DOC_FULLTEXT_THRESHOLD_CHARS = 6000
const DEFAULT_ATTACH_MAX_GLOBAL_SUMMARY_CHARS = 6000

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'by', 'is', 'are', 'was', 'were',
  'be', 'been', 'this', 'that', 'it', 'as', 'at', 'from', 'we', 'you', 'your', 'our', 'their', 'they',
  'i', 'me', 'my', 'mine', 'he', 'she', 'his', 'her', 'its', 'them', 'but', 'if', 'then', 'than', 'so',
  '并', '和', '与', '及', '是', '在', '了', '的', '地', '得', '对', '把', '被', '将', '为', '于', '及其',
  '或者', '以及', '一个', '我们', '你们', '他们', '她们', '它们', '这些', '那些', '这个', '那个',
])

export interface DocumentAttachmentInput {
  id: string
  filename: string
  mimeType: string
  size: number
  textContent?: string
  isImage?: boolean
}

type ChunkCatalogItem = {
  chunkId: string
  section?: string
  page?: number
  keywords: string[]
  summary: string
}

type CitationMapItem = {
  chunkId: string
  page?: number
  section?: string
  preview: string
}

type ProcessedDocument = {
  docId: string
  version: number
  title: string
  chunkCount: number
  globalSummary: string
  chunkCatalog: ChunkCatalogItem[]
  citationMap: CitationMapItem[]
}

export type DocumentContextReference = {
  docId: string
  version: number
  title: string
  chunkCount: number
  summaryChars: number
  workspaceRootRelativePath: string
}

export type PreparedDocumentContext = {
  contextBlock: string
  references: DocumentContextReference[]
}

export type ChunkExpansionResult = {
  expansionBlock: string
  resolvedChunkIds: string[]
  missingChunkIds: string[]
  ambiguousChunkIds: string[]
}

export type DocumentChunkContent = {
  docId: string
  version: number
  chunkId: string
  content: string
}

export type DocumentChunkResolution =
  | {
    kind: 'resolved'
    chunk: DocumentChunkContent
  }
  | {
    kind: 'ambiguous'
    references: DocumentContextReference[]
  }
  | {
    kind: 'not_found'
    references: DocumentContextReference[]
  }

export function normalizeChunkCitationSyntax(text: string): string {
  if (!text) return ''
  let normalized = String(text)

  normalized = normalized.replace(/\[\s*doc:([A-Za-z0-9_-]+)\s+chunk:\s*(c\d{3,})\s*\]/gi, (_match, docId, chunkId) => {
    return `[doc:${String(docId).trim()} chunk:${String(chunkId).trim().toLowerCase()}]`
  })

  normalized = normalized.replace(/\[\s*chunk:\s*([^\]]+)\s*\]/gi, (_match, body) => {
    const chunks = String(body)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^c\d{3,}$/i.test(item))
    if (chunks.length === 0) return _match
    return `[chunk:${chunks.join(',')}]`
  })

  normalized = normalized.replace(/(^|[^\[])doc:([A-Za-z0-9_-]+)\s+chunk:\s*(c\d{3,})\b/gi, (_match, prefix, docId, chunkId) => {
    return `${prefix}[doc:${String(docId).trim()} chunk:${String(chunkId).trim().toLowerCase()}]`
  })

  normalized = normalized.replace(/(^|[^\[])chunk:\s*(c\d{3,}(?:\s*,\s*c\d{3,})*)\b/gi, (_match, prefix, chunkBody, offset, source) => {
    const start = Math.max(0, Number(offset) - 32)
    const before = String(source).slice(start, Number(offset)).toLowerCase()
    if (/\[doc:[a-z0-9_-]+\s*$/.test(before) || /doc:[a-z0-9_-]+\s*$/.test(before)) {
      return `${prefix}chunk:${String(chunkBody)}`
    }
    const chunks = String(chunkBody)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^c\d{3,}$/i.test(item))
    if (chunks.length === 0) return `${prefix}chunk:${String(chunkBody)}`
    return `${prefix}[chunk:${chunks.join(',')}]`
  })

  return normalized
}

export function renderChunkEvidenceLinks(text: string): string {
  if (!text) return ''
  let rendered = normalizeChunkCitationSyntax(text)
  rendered = rendered.replace(/\[doc:([A-Za-z0-9_-]+)\s+chunk:(c\d{3,})\]/gi, (_match, docId, chunkId) => {
    const safeDocId = encodeURIComponent(String(docId).trim())
    const safeChunkId = encodeURIComponent(String(chunkId).trim().toLowerCase())
    return `[[doc:${String(docId).trim()} chunk:${String(chunkId).trim().toLowerCase()}]](semibot-evidence://chunk?doc_id=${safeDocId}&chunk_id=${safeChunkId})`
  })
  rendered = rendered.replace(/\[chunk:([^\]]+)\]/gi, (_match, body) => {
    const chunkIds = String(body)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^c\d{3,}$/i.test(item))
    if (chunkIds.length === 0) return _match
    const safeChunkIds = encodeURIComponent(chunkIds.join(','))
    return `[[chunk:${chunkIds.join(',')}]](semibot-evidence://chunk?chunk_ids=${safeChunkIds})`
  })
  return rendered
}

function intEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(1, Math.floor(raw))
}

function semibotHomeDir(): string {
  const configured = String(process.env.SEMIBOT_HOME || '').trim()
  if (configured) return configured
  return path.join(os.homedir(), '.semibot')
}

function resolveWorkspaceRoot(): string {
  return path.join(semibotHomeDir(), 'workspaces')
}

function normalizeSessionId(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return crypto.createHash('sha1').update(trimmed).digest('hex')
}

function normalizeDocId(raw: string): string {
  const seed = String(raw || '').trim()
  const cleaned = seed.replace(/[^A-Za-z0-9_-]/g, '')
  if (cleaned) return cleaned
  return crypto.createHash('sha1').update(seed || crypto.randomUUID()).digest('hex').slice(0, 16)
}

function normalizeText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function estimateTokens(input: string): number {
  return Math.ceil(input.length / 4)
}

function splitChunks(text: string, size: number, overlap: number): Array<{ chunkId: string; text: string; tokenEstimate: number }> {
  if (!text) return []
  const chunks: Array<{ chunkId: string; text: string; tokenEstimate: number }> = []
  let cursor = 0
  let index = 1
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(size / 2)))
  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + size)
    const chunkText = text.slice(cursor, end).trim()
    if (chunkText) {
      const chunkId = `c${String(index).padStart(4, '0')}`
      chunks.push({
        chunkId,
        text: chunkText,
        tokenEstimate: estimateTokens(chunkText),
      })
      index += 1
    }
    if (end >= text.length) break
    cursor = Math.max(end - safeOverlap, cursor + 1)
  }
  return chunks
}

function summarizeChunk(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 3).trimEnd()}...`
}

function extractKeywords(text: string, topN = 6): string[] {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])
    .map((t) => t.trim())
    .filter((t) => t && !STOPWORDS.has(t))
  const freq = new Map<string, number>()
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1)
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([token]) => token)
}

function buildGlobalSummary(chunks: Array<{ text: string; chunkId: string }>, fullText: string): string {
  const threshold = intEnv('CHAT_ATTACH_SMALL_DOC_FULLTEXT_THRESHOLD_CHARS', DEFAULT_ATTACH_SMALL_DOC_FULLTEXT_THRESHOLD_CHARS)
  const maxSummaryChars = intEnv('CHAT_ATTACH_MAX_GLOBAL_SUMMARY_CHARS', DEFAULT_ATTACH_MAX_GLOBAL_SUMMARY_CHARS)
  if (fullText.length <= threshold) {
    return fullText.slice(0, maxSummaryChars)
  }
  const lines = chunks.slice(0, 12).map((item, idx) => `${idx + 1}. ${summarizeChunk(item.text, 200)} [chunk:${item.chunkId}]`)
  const summary = lines.join('\n')
  if (summary.length <= maxSummaryChars) return summary
  return `${summary.slice(0, maxSummaryChars - 3).trimEnd()}...`
}

function toJsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join('\n')
}

async function resolveNextVersion(docRoot: string): Promise<number> {
  if (!(await fs.pathExists(docRoot))) return 1
  const entries = await fs.readdir(docRoot, { withFileTypes: true })
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => /^v(\d+)$/.exec(entry.name))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (versions.length === 0) return 1
  return Math.max(...versions) + 1
}

async function materializeDocumentWorkspace(
  sessionId: string,
  attachment: DocumentAttachmentInput,
  normalizedText: string
): Promise<ProcessedDocument> {
  const chunkSize = intEnv('CHAT_ATTACH_CHUNK_SIZE_CHARS', DEFAULT_ATTACH_CHUNK_SIZE_CHARS)
  const overlap = intEnv('CHAT_ATTACH_CHUNK_OVERLAP_CHARS', DEFAULT_ATTACH_CHUNK_OVERLAP_CHARS)
  const safeSessionId = normalizeSessionId(sessionId)
  const workspaceRoot = resolveWorkspaceRoot()
  const docId = normalizeDocId(attachment.id || attachment.filename)
  const docRoot = path.join(workspaceRoot, safeSessionId, 'docs', docId)
  const version = await resolveNextVersion(docRoot)
  const finalVersionDir = path.join(docRoot, `v${version}`)
  const tmpVersionDir = `${finalVersionDir}.tmp-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

  const chunks = splitChunks(normalizedText, chunkSize, overlap)
  const globalSummary = buildGlobalSummary(
    chunks.map((c) => ({ text: c.text, chunkId: c.chunkId })),
    normalizedText
  )
  const chunkCatalog: ChunkCatalogItem[] = chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    keywords: extractKeywords(chunk.text),
    summary: summarizeChunk(chunk.text),
  }))
  const citationMap: CitationMapItem[] = chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    preview: summarizeChunk(chunk.text, 140),
  }))

  await fs.ensureDir(path.join(tmpVersionDir, 'chunks'))
  for (const chunk of chunks) {
    await fs.writeFile(path.join(tmpVersionDir, 'chunks', `${chunk.chunkId}.txt`), `${chunk.text}\n`, 'utf-8')
  }

  const manifest = {
    schemaVersion: '1.0',
    ready: true,
    docId,
    version,
    title: attachment.filename,
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    source: {
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    },
  }

  await fs.writeJson(path.join(tmpVersionDir, 'manifest.json'), manifest, { spaces: 2 })
  await fs.writeFile(path.join(tmpVersionDir, 'global_summary.md'), `${globalSummary}\n`, 'utf-8')
  await fs.writeFile(path.join(tmpVersionDir, 'chunk_catalog.jsonl'), `${toJsonl(chunkCatalog)}\n`, 'utf-8')
  await fs.writeJson(path.join(tmpVersionDir, 'citation_map.json'), citationMap, { spaces: 2 })

  await fs.ensureDir(docRoot)
  if (await fs.pathExists(finalVersionDir)) {
    await fs.remove(finalVersionDir)
  }
  await fs.rename(tmpVersionDir, finalVersionDir)

  return {
    docId,
    version,
    title: attachment.filename,
    chunkCount: chunks.length,
    globalSummary,
    chunkCatalog,
    citationMap,
  }
}

function renderDocContextBlock(documents: ProcessedDocument[]): string {
  const maxCatalogItems = intEnv('CHAT_ATTACH_MAX_CHUNK_CATALOG_ITEMS', DEFAULT_ATTACH_MAX_CHUNK_CATALOG_ITEMS)
  const totalBudget = intEnv('CHAT_ATTACH_TOTAL_BUDGET_CHARS', DEFAULT_ATTACH_TOTAL_BUDGET_CHARS)

  const lines: string[] = ['[DOCUMENT_CONTEXT_BEGIN]']
  let catalogRemaining = maxCatalogItems

  for (const doc of documents) {
    lines.push(`doc_id: ${doc.docId}`)
    lines.push(`doc_version: v${doc.version}`)
    lines.push(`doc_title: ${doc.title}`)
    lines.push(`chunk_count: ${doc.chunkCount}`)
    lines.push('global_summary:')
    lines.push(doc.globalSummary)
    lines.push('chunk_catalog:')
    const docCatalog = doc.chunkCatalog.slice(0, Math.max(0, catalogRemaining))
    for (const item of docCatalog) {
      lines.push(
        `- chunk_id: ${item.chunkId} | keywords: ${(item.keywords || []).join(', ')} | summary: ${item.summary}`
      )
    }
    catalogRemaining -= docCatalog.length
    lines.push('citation_map:')
    for (const citation of doc.citationMap.slice(0, 8)) {
      lines.push(`- ${citation.chunkId} => preview="${citation.preview}"`)
    }
    lines.push(
      `retrieval_hint: 需要回溯原文时，使用 file_io 读取 docs/${doc.docId}/v${doc.version}/chunks/<chunk_id>.txt`
    )
    lines.push('')
  }

  lines.push('retrieval_rules:')
  lines.push('1) 回答中的事实应优先引用 chunk（例如 [chunk:c0001]）。')
  lines.push('2) 需要证据时先标注 chunk_id，再读取对应 chunk 原文。')
  lines.push('3) 不要杜撰 catalog 未覆盖的事实。')
  lines.push('[DOCUMENT_CONTEXT_END]')

  let payload = lines.join('\n')
  if (payload.length <= totalBudget) return payload

  const reduced = lines.slice(0, Math.max(20, lines.length - 1))
  payload = `${reduced.join('\n')}\n[DOCUMENT_CONTEXT_END]`
  if (payload.length <= totalBudget) return payload
  return `${payload.slice(0, totalBudget - 3).trimEnd()}...`
}

type ChunkExpansionRequest = {
  docId?: string
  chunkId: string
}

function extractChunkRequestsFromText(text: string): ChunkExpansionRequest[] {
  const raw = String(text || '')
  const requests: ChunkExpansionRequest[] = []
  const seen = new Set<string>()
  const explicitChunkIds = new Set<string>()

  for (const match of raw.matchAll(/\[doc:([A-Za-z0-9_-]+)\s+chunk:([^\]]+)\]/gi)) {
    const docId = String(match[1] || '').trim()
    const body = String(match[2] || '')
    for (const token of body.split(',')) {
      const normalized = token.trim().toLowerCase()
      if (!/^c\d{3,}$/i.test(normalized)) continue
      const key = `${docId}:${normalized}`
      if (seen.has(key)) continue
      seen.add(key)
      explicitChunkIds.add(normalized)
      requests.push({ docId, chunkId: normalized })
    }
  }

  for (const match of raw.matchAll(/\bdoc:([A-Za-z0-9_-]+)\s+chunk[:\s]+(c\d{3,})\b/gi)) {
    const docId = String(match[1] || '').trim()
    const normalized = String(match[2] || '').trim().toLowerCase()
    const key = `${docId}:${normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    explicitChunkIds.add(normalized)
    requests.push({ docId, chunkId: normalized })
  }

  for (const match of raw.matchAll(/\[chunk:([^\]]+)\]/gi)) {
    const body = String(match[1] || '')
    for (const token of body.split(',')) {
      const normalized = token.trim().toLowerCase()
      if (!/^c\d{3,}$/i.test(normalized)) continue
      if (explicitChunkIds.has(normalized)) continue
      const key = `*:${normalized}`
      if (seen.has(key)) continue
      seen.add(key)
      requests.push({ chunkId: normalized })
    }
  }

  for (const match of raw.matchAll(/\bchunk[:\s]+(c\d{3,})\b/gi)) {
    const normalized = String(match[1] || '').trim().toLowerCase()
    if (explicitChunkIds.has(normalized)) continue
    const key = `*:${normalized}`
    if (seen.has(key)) continue
    seen.add(key)
    requests.push({ chunkId: normalized })
  }

  return requests
}

function resolveChunkFileCandidate(
  sessionId: string,
  reference: DocumentContextReference,
  chunkId: string
): string {
  return path.join(
    resolveWorkspaceRoot(),
    normalizeSessionId(sessionId),
    reference.workspaceRootRelativePath,
    'chunks',
    `${chunkId}.txt`
  )
}

function resolveChunkFileByIds(sessionId: string, docId: string, version: number, chunkId: string): string {
  return path.join(
    resolveWorkspaceRoot(),
    normalizeSessionId(sessionId),
    'docs',
    normalizeDocId(docId),
    `v${version}`,
    'chunks',
    `${chunkId}.txt`
  )
}

export async function listSessionDocumentReferences(sessionId: string): Promise<DocumentContextReference[]> {
  const docsRoot = path.join(resolveWorkspaceRoot(), normalizeSessionId(sessionId), 'docs')
  if (!(await fs.pathExists(docsRoot))) return []

  const docEntries = await fs.readdir(docsRoot, { withFileTypes: true })
  const references: DocumentContextReference[] = []

  for (const docEntry of docEntries) {
    if (!docEntry.isDirectory()) continue
    const docDir = path.join(docsRoot, docEntry.name)
    const versionEntries = await fs.readdir(docDir, { withFileTypes: true }).catch(() => [])
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) continue
      const match = /^v(\d+)$/.exec(versionEntry.name)
      if (!match) continue
      const version = Number(match[1])
      if (!Number.isFinite(version) || version <= 0) continue
      const versionDir = path.join(docDir, versionEntry.name)
      const manifestPath = path.join(versionDir, 'manifest.json')
      if (!(await fs.pathExists(manifestPath))) continue
      const manifest = await fs.readJson(manifestPath).catch(() => null) as
        | { docId?: unknown; title?: unknown; chunkCount?: unknown }
        | null
      const docId = typeof manifest?.docId === 'string' ? manifest.docId : docEntry.name
      const title = typeof manifest?.title === 'string' && manifest.title.trim() ? manifest.title : docId
      const chunkCount = typeof manifest?.chunkCount === 'number'
        ? manifest.chunkCount
        : Number(manifest?.chunkCount || 0)
      references.push({
        docId,
        version,
        title,
        chunkCount,
        summaryChars: 0,
        workspaceRootRelativePath: `docs/${docEntry.name}/v${version}`,
      })
    }
  }

  return references.sort((a, b) => {
    if (a.docId === b.docId) return a.version - b.version
    return a.docId.localeCompare(b.docId)
  })
}

export async function readDocumentChunk(args: {
  sessionId: string
  docId: string
  version: number
  chunkId: string
}): Promise<DocumentChunkContent | null> {
  const target = resolveChunkFileByIds(args.sessionId, args.docId, args.version, args.chunkId)
  if (!(await fs.pathExists(target))) return null
  const content = normalizeText(await fs.readFile(target, 'utf-8'))
  return {
    docId: args.docId,
    version: args.version,
    chunkId: args.chunkId,
    content,
  }
}

export async function resolveDocumentChunk(args: {
  sessionId: string
  chunkId: string
  docId?: string
  version?: number
}): Promise<DocumentChunkResolution> {
  const chunkId = String(args.chunkId || '').trim().toLowerCase()
  if (!chunkId) {
    return { kind: 'not_found', references: [] }
  }

  if (args.docId && args.version) {
    const chunk = await readDocumentChunk({
      sessionId: args.sessionId,
      docId: args.docId,
      version: args.version,
      chunkId,
    })
    if (chunk) return { kind: 'resolved', chunk }
    return { kind: 'not_found', references: [] }
  }

  const references = await listSessionDocumentReferences(args.sessionId)
  if (references.length === 0) {
    return { kind: 'not_found', references: [] }
  }

  const matches: Array<{ reference: DocumentContextReference; chunk: DocumentChunkContent }> = []
  for (const reference of references) {
    const chunk = await readDocumentChunk({
      sessionId: args.sessionId,
      docId: reference.docId,
      version: reference.version,
      chunkId,
    })
    if (!chunk) continue
    matches.push({ reference, chunk })
  }

  if (matches.length === 1) {
    return { kind: 'resolved', chunk: matches[0].chunk }
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      references: matches.map((item) => item.reference),
    }
  }

  if (references.length === 1) {
    const only = references[0]
    const chunk = await readDocumentChunk({
      sessionId: args.sessionId,
      docId: only.docId,
      version: only.version,
      chunkId,
    })
    if (chunk) {
      return { kind: 'resolved', chunk }
    }
  }

  return { kind: 'not_found', references }
}

export async function buildChunkExpansionBlock(args: {
  sessionId: string
  references: DocumentContextReference[]
  sourceText: string
}): Promise<ChunkExpansionResult> {
  const requestedChunks = extractChunkRequestsFromText(args.sourceText)
  if (requestedChunks.length === 0 || args.references.length === 0) {
    return {
      expansionBlock: '',
      resolvedChunkIds: [],
      missingChunkIds: [],
      ambiguousChunkIds: [],
    }
  }

  const maxExpansions = Math.min(8, requestedChunks.length)
  const resolvedLines: string[] = ['[DOCUMENT_CHUNK_EXPANSION_BEGIN]']
  const resolvedChunkIds: string[] = []
  const missingChunkIds: string[] = []
  const ambiguousChunkIds: string[] = []

  for (const request of requestedChunks.slice(0, maxExpansions)) {
    const chunkId = request.chunkId
    const candidateReferences = request.docId
      ? args.references.filter((item) => item.docId === request.docId)
      : args.references

    const matches: Array<{ reference: DocumentContextReference; text: string }> = []
    for (const reference of candidateReferences) {
      const target = resolveChunkFileCandidate(args.sessionId, reference, chunkId)
      if (!(await fs.pathExists(target))) continue
      matches.push({
        reference,
        text: normalizeText(await fs.readFile(target, 'utf-8')),
      })
    }

    if (matches.length === 0) {
      missingChunkIds.push(chunkId)
      continue
    }
    if (!request.docId && matches.length > 1) {
      ambiguousChunkIds.push(chunkId)
      continue
    }
    const selected = matches[0]
    if (!selected.text) {
      missingChunkIds.push(chunkId)
      continue
    }

    resolvedChunkIds.push(chunkId)
    resolvedLines.push(`doc_id: ${selected.reference.docId}`)
    resolvedLines.push(`doc_version: v${selected.reference.version}`)
    resolvedLines.push(`- chunk_id: ${chunkId}`)
    resolvedLines.push(`  text: ${selected.text.replace(/\n/g, '\\n')}`)
  }

  if (missingChunkIds.length > 0) {
    resolvedLines.push(`missing_chunk_ids: ${missingChunkIds.join(', ')}`)
  }
  if (ambiguousChunkIds.length > 0) {
    resolvedLines.push(`ambiguous_chunk_ids: ${ambiguousChunkIds.join(', ')}`)
    resolvedLines.push('ambiguity_hint: specify [doc:<doc_id> chunk:<chunk_id>] to disambiguate')
  }
  resolvedLines.push('[DOCUMENT_CHUNK_EXPANSION_END]')

  return {
    expansionBlock:
      resolvedChunkIds.length > 0 || missingChunkIds.length > 0 || ambiguousChunkIds.length > 0
        ? resolvedLines.join('\n')
        : '',
    resolvedChunkIds,
    missingChunkIds,
    ambiguousChunkIds,
  }
}

export async function prepareDocumentContextForChat(args: {
  sessionId: string
  attachments?: DocumentAttachmentInput[]
}): Promise<PreparedDocumentContext> {
  const attachments = Array.isArray(args.attachments) ? args.attachments : []
  const textAttachments = attachments.filter((att) => !att.isImage && typeof att.textContent === 'string' && att.textContent.trim())
  if (textAttachments.length === 0) {
    return {
      contextBlock: '',
      references: [],
    }
  }

  const documents: ProcessedDocument[] = []
  for (const attachment of textAttachments) {
    const normalized = normalizeText(String(attachment.textContent || ''))
    if (!normalized) continue
    const processed = await materializeDocumentWorkspace(args.sessionId, attachment, normalized)
    documents.push(processed)
  }

  if (documents.length === 0) {
    return {
      contextBlock: '',
      references: [],
    }
  }

  const references: DocumentContextReference[] = documents.map((doc) => ({
    docId: doc.docId,
    version: doc.version,
    title: doc.title,
    chunkCount: doc.chunkCount,
    summaryChars: doc.globalSummary.length,
    workspaceRootRelativePath: `docs/${doc.docId}/v${doc.version}`,
  }))

  return {
    contextBlock: renderDocContextBlock(documents),
    references,
  }
}
