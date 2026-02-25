/**
 * 文件内容提取器
 *
 * 根据文件 MIME 类型提取文本内容或编码为 base64
 * 支持: 纯文本/代码、PDF、DOCX、XLSX、图片
 */

import fs from 'fs-extra'
import path from 'path'
import { createLogger } from '../lib/logger'
import { CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH } from '../constants/config'

const extractorLogger = createLogger('file-extractor')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ExtractedContent {
  /** 提取的文本内容（文本/PDF/Office） */
  text: string | null
  /** 图片的 base64 编码 */
  base64?: string
  /** MIME 类型 */
  mimeType: string
  /** 是否为图片 */
  isImage: boolean
}

// ═══════════════════════════════════════════════════════════════
// 文本类扩展名（按 utf-8 读取）
// ═══════════════════════════════════════════════════════════════

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h',
  '.html', '.css', '.sql', '.sh', '.log', '.env', '.toml', '.ini', '.cfg', '.svg',
])

// ═══════════════════════════════════════════════════════════════
// 提取函数
// ═══════════════════════════════════════════════════════════════

/**
 * 提取文件内容
 */
export async function extractFileContent(
  filePath: string,
  mimeType: string,
  originalName: string
): Promise<ExtractedContent> {
  const ext = path.extname(originalName).toLowerCase()

  try {
    // 图片
    if (mimeType.startsWith('image/') && ext !== '.svg') {
      return await extractImage(filePath, mimeType)
    }

    // 纯文本/代码
    if (mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext)) {
      return await extractText(filePath, mimeType)
    }

    // PDF
    if (mimeType === 'application/pdf' || ext === '.pdf') {
      return await extractPdf(filePath, mimeType)
    }

    // DOCX
    if (ext === '.docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return await extractDocx(filePath, mimeType)
    }

    // XLSX
    if (ext === '.xlsx' || ext === '.xls' || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      return await extractXlsx(filePath, mimeType)
    }

    // 其他：返回元信息
    extractorLogger.info('不支持内容提取的文件类型', { ext, mimeType, originalName })
    return { text: null, mimeType, isImage: false }
  } catch (error) {
    extractorLogger.error('文件内容提取失败', {
      filePath,
      mimeType,
      originalName,
      error: (error as Error).message,
    })
    return { text: null, mimeType, isImage: false }
  }
}

// ═══════════════════════════════════════════════════════════════
// 各类型提取实现
// ═══════════════════════════════════════════════════════════════

async function extractText(filePath: string, mimeType: string): Promise<ExtractedContent> {
  const raw = await fs.readFile(filePath, 'utf-8')
  let text = raw
  if (text.length > CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) {
    extractorLogger.warn('文本内容超出限制，已截断', {
      originalLength: text.length,
      limit: CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH,
    })
    text = text.slice(0, CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) + '\n...[内容已截断]'
  }
  return { text, mimeType, isImage: false }
}

async function extractPdf(filePath: string, mimeType: string): Promise<ExtractedContent> {
  const { PDFParse } = await import('pdf-parse')
  const buffer = await fs.readFile(filePath)
  const pdf = new PDFParse({ data: new Uint8Array(buffer) })
  const textResult = await pdf.getText()
  await pdf.destroy()
  let text = textResult.text ?? ''
  if (text.length > CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) {
    extractorLogger.warn('PDF 文本超出限制，已截断', {
      originalLength: text.length,
      limit: CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH,
    })
    text = text.slice(0, CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) + '\n...[内容已截断]'
  }
  return { text, mimeType, isImage: false }
}

async function extractDocx(filePath: string, mimeType: string): Promise<ExtractedContent> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: filePath })
  let text = result.value ?? ''
  if (text.length > CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) {
    extractorLogger.warn('DOCX 文本超出限制，已截断', {
      originalLength: text.length,
      limit: CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH,
    })
    text = text.slice(0, CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) + '\n...[内容已截断]'
  }
  return { text, mimeType, isImage: false }
}

async function extractXlsx(filePath: string, mimeType: string): Promise<ExtractedContent> {
  const XLSX = await import('xlsx')
  const workbook = XLSX.readFile(filePath)
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`--- Sheet: ${sheetName} ---\n${csv}`)
  }
  let text = parts.join('\n\n')
  if (text.length > CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) {
    extractorLogger.warn('XLSX 文本超出限制，已截断', {
      originalLength: text.length,
      limit: CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH,
    })
    text = text.slice(0, CHAT_UPLOAD_TEXT_TRUNCATE_LENGTH) + '\n...[内容已截断]'
  }
  return { text, mimeType, isImage: false }
}

async function extractImage(filePath: string, mimeType: string): Promise<ExtractedContent> {
  const buffer = await fs.readFile(filePath)
  const base64 = buffer.toString('base64')
  return { text: null, base64, mimeType, isImage: true }
}
