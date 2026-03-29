import os from 'os'
import path from 'path'
import fs from 'fs-extra'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildChunkExpansionBlock,
  normalizeChunkCitationSyntax,
  prepareDocumentContextForChat,
} from '../services/document-context.service'

describe('document-context.service', () => {
  let tmpHome = ''
  let prevHome = ''

  beforeEach(async () => {
    prevHome = process.env.SEMIBOT_HOME || ''
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'semibot-doc-context-'))
    process.env.SEMIBOT_HOME = tmpHome
  })

  afterEach(async () => {
    if (prevHome) process.env.SEMIBOT_HOME = prevHome
    else delete process.env.SEMIBOT_HOME
    if (tmpHome) await fs.remove(tmpHome)
  })

  it('materializes workspace document package and context block', async () => {
    const sessionId = 'c4c2d39a-ff66-46ad-8184-a12e3bd899a0'
    const result = await prepareDocumentContextForChat({
      sessionId,
      attachments: [
        {
          id: 'doc-001',
          filename: 'sample.txt',
          mimeType: 'text/plain',
          size: 42,
          textContent: '这是一段测试文本。用于验证文档上下文注入与工作区落盘。',
          isImage: false,
        },
      ],
    })

    expect(result.contextBlock).toContain('[DOCUMENT_CONTEXT_BEGIN]')
    expect(result.contextBlock).toContain('[DOCUMENT_CONTEXT_END]')
    expect(result.references).toHaveLength(1)
    expect(result.references[0].docId).toBe('doc-001')
    expect(result.contextBlock).toContain('docs/doc-001/v1/chunks/<chunk_id>.txt')

    const versionRoot = path.join(
      tmpHome,
      'workspaces',
      sessionId,
      'docs',
      'doc-001',
      'v1'
    )
    expect(await fs.pathExists(path.join(versionRoot, 'manifest.json'))).toBe(true)
    expect(await fs.pathExists(path.join(versionRoot, 'global_summary.md'))).toBe(true)
    expect(await fs.pathExists(path.join(versionRoot, 'chunk_catalog.jsonl'))).toBe(true)
    expect(await fs.pathExists(path.join(versionRoot, 'chunks', 'c0001.txt'))).toBe(true)

    const manifest = await fs.readJson(path.join(versionRoot, 'manifest.json'))
    expect(manifest.ready).toBe(true)
    expect(manifest.chunkCount).toBeGreaterThan(0)
  })

  it('keeps small-doc summary close to full text under unified pipeline', async () => {
    const sessionId = '11111111-1111-1111-1111-111111111111'
    const fullText = '小文档直走统一处理链，摘要应当与全文一致。'
    const result = await prepareDocumentContextForChat({
      sessionId,
      attachments: [
        {
          id: 'small-doc',
          filename: 'small.md',
          mimeType: 'text/markdown',
          size: 64,
          textContent: fullText,
          isImage: false,
        },
      ],
    })

    expect(result.references).toHaveLength(1)
    const summaryPath = path.join(
      tmpHome,
      'workspaces',
      sessionId,
      'docs',
      'small-doc',
      'v1',
      'global_summary.md'
    )
    const summary = (await fs.readFile(summaryPath, 'utf-8')).trim()
    expect(summary).toBe(fullText)
  })

  it('builds chunk expansion block from explicit chunk citations', async () => {
    const sessionId = '22222222-2222-2222-2222-222222222222'
    const prepared = await prepareDocumentContextForChat({
      sessionId,
      attachments: [
        {
          id: 'doc-expand',
          filename: 'expand.txt',
          mimeType: 'text/plain',
          size: 100,
          textContent: '第一段内容。第二段内容。第三段内容。',
          isImage: false,
        },
      ],
    })

    const expansion = await buildChunkExpansionBlock({
      sessionId,
      references: prepared.references,
      sourceText: '请展开 [chunk:c0001] 原文',
    })

    expect(expansion.resolvedChunkIds).toEqual(['c0001'])
    expect(expansion.missingChunkIds).toEqual([])
    expect(expansion.expansionBlock).toContain('[DOCUMENT_CHUNK_EXPANSION_BEGIN]')
    expect(expansion.expansionBlock).toContain('doc_id: doc-expand')
    expect(expansion.expansionBlock).toContain('chunk_id: c0001')
  })

  it('marks ambiguous chunk ids when multiple docs share the same chunk id and doc_id is omitted', async () => {
    const sessionId = '33333333-3333-3333-3333-333333333333'
    const prepared = await prepareDocumentContextForChat({
      sessionId,
      attachments: [
        {
          id: 'doc-a',
          filename: 'a.txt',
          mimeType: 'text/plain',
          size: 10,
          textContent: '文档A内容',
          isImage: false,
        },
        {
          id: 'doc-b',
          filename: 'b.txt',
          mimeType: 'text/plain',
          size: 10,
          textContent: '文档B内容',
          isImage: false,
        },
      ],
    })

    const expansion = await buildChunkExpansionBlock({
      sessionId,
      references: prepared.references,
      sourceText: '请展开 [chunk:c0001] 原文',
    })

    expect(expansion.resolvedChunkIds).toEqual([])
    expect(expansion.ambiguousChunkIds).toEqual(['c0001'])
    expect(expansion.expansionBlock).toContain('ambiguous_chunk_ids: c0001')
    expect(expansion.expansionBlock).toContain('specify [doc:<doc_id> chunk:<chunk_id>]')
  })

  it('supports explicit doc_id + chunk_id expansion in multi-doc sessions', async () => {
    const sessionId = '44444444-4444-4444-4444-444444444444'
    const prepared = await prepareDocumentContextForChat({
      sessionId,
      attachments: [
        {
          id: 'doc-a',
          filename: 'a.txt',
          mimeType: 'text/plain',
          size: 10,
          textContent: '文档A内容',
          isImage: false,
        },
        {
          id: 'doc-b',
          filename: 'b.txt',
          mimeType: 'text/plain',
          size: 10,
          textContent: '文档B内容',
          isImage: false,
        },
      ],
    })

    const expansion = await buildChunkExpansionBlock({
      sessionId,
      references: prepared.references,
      sourceText: '请展开 [doc:doc-b chunk:c0001] 原文',
    })

    expect(expansion.resolvedChunkIds).toEqual(['c0001'])
    expect(expansion.ambiguousChunkIds).toEqual([])
    expect(expansion.expansionBlock).toContain('doc_id: doc-b')
    expect(expansion.expansionBlock).toContain('文档B内容')
  })

  it('normalizes loose chunk citation syntax into stable bracketed forms', () => {
    const output = normalizeChunkCitationSyntax(
      '依据 doc:doc-b chunk:c0001 和 chunk:c0002, c0003 得出结论；另见 [ chunk:c0004 ]。'
    )

    expect(output).toContain('[doc:doc-b chunk:c0001]')
    expect(output).toContain('[chunk:c0002,c0003]')
    expect(output).toContain('[chunk:c0004]')
  })
})
