/**
 * 聊天文件上传中间件
 *
 * 基于 busboy 的流式 multipart/form-data 解析
 * 支持多文件上传（最多 5 个），单文件最大 10MB
 */

import type { Request, Response, NextFunction } from 'express'
import Busboy from 'busboy'
import { createWriteStream } from 'fs'
import fs from 'fs-extra'
import * as path from 'path'
import * as crypto from 'crypto'
import { createError } from './errorHandler'
import {
  CHAT_UPLOAD_TEMP_DIR,
  CHAT_UPLOAD_MAX_SIZE_BYTES,
  CHAT_UPLOAD_MAX_FILES,
  CHAT_UPLOAD_ALLOWED_EXTENSIONS,
} from '../constants/config'
import {
  CHAT_UPLOAD_TOO_LARGE,
  CHAT_UPLOAD_INVALID_TYPE,
  CHAT_UPLOAD_TOO_MANY_FILES,
} from '../constants/errorCodes'
import { createLogger } from '../lib/logger'

const uploadLogger = createLogger('chat-upload')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface ChatUploadedFile {
  originalName: string
  mimeType: string
  tempPath: string
  size: number
}

export interface ChatUploadRequest extends Request {
  chatFiles?: ChatUploadedFile[]
  chatFields?: Record<string, string>
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

function isAllowedExtension(filename: string): boolean {
  const lowerName = filename.toLowerCase()
  return CHAT_UPLOAD_ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
}

function generateTempPath(originalName: string): string {
  const randomId = crypto.randomBytes(16).toString('hex')
  const ext = path.extname(originalName)
  return path.join(CHAT_UPLOAD_TEMP_DIR, `${randomId}${ext}`)
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath)
    }
  } catch (err) {
    uploadLogger.warn('清理临时文件失败', { filePath, error: (err as Error).message })
  }
}

export async function cleanupChatFiles(files: ChatUploadedFile[]): Promise<void> {
  await Promise.all(files.map((f) => cleanupTempFile(f.tempPath)))
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═══════════════════════════════════════════════════════════════

export function handleChatUpload(req: ChatUploadRequest, _res: Response, next: NextFunction): void {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('multipart/form-data')) {
    next()
    return
  }

  uploadLogger.info('开始处理聊天文件上传', {
    contentType,
    contentLength: req.headers['content-length'],
  })

  fs.ensureDirSync(CHAT_UPLOAD_TEMP_DIR)

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: CHAT_UPLOAD_MAX_SIZE_BYTES,
      files: CHAT_UPLOAD_MAX_FILES,
    },
  })

  const uploadedFiles: ChatUploadedFile[] = []
  const fields: Record<string, string> = {}
  let fileCount = 0
  let hasError = false
  let pendingWrites = 0
  let busboyFinished = false

  function tryFinalize() {
    if (!busboyFinished || pendingWrites > 0 || hasError) return

    req.chatFiles = uploadedFiles
    req.chatFields = fields
    uploadLogger.info('聊天文件上传完成', {
      fileCount: uploadedFiles.length,
      fields: Object.keys(fields),
    })
    next()
  }

  function handleUploadError(errorCode: string, message: string) {
    if (hasError) return
    hasError = true
    // 清理已上传的临时文件
    cleanupChatFiles(uploadedFiles)
    next(createError(errorCode, message))
  }

  busboy.on('field', (fieldName: string, value: string) => {
    fields[fieldName] = value
  })

  busboy.on('file', (
    _fieldName: string,
    fileStream: NodeJS.ReadableStream,
    info: { filename: string; encoding: string; mimeType: string }
  ) => {
    const { filename, mimeType } = info

    if (!filename) {
      fileStream.resume()
      return
    }

    fileCount++
    if (fileCount > CHAT_UPLOAD_MAX_FILES) {
      fileStream.resume()
      handleUploadError(
        CHAT_UPLOAD_TOO_MANY_FILES,
        `文件数量超过限制 (最多 ${CHAT_UPLOAD_MAX_FILES} 个)`
      )
      return
    }

    if (!isAllowedExtension(filename)) {
      fileStream.resume()
      handleUploadError(CHAT_UPLOAD_INVALID_TYPE, `不支持的文件类型: ${filename}`)
      return
    }

    const tempPath = generateTempPath(filename)
    const writeStream = createWriteStream(tempPath)
    let fileSize = 0
    let fileLimitReached = false

    pendingWrites++

    fileStream.on('data', (chunk: Buffer) => {
      fileSize += chunk.length
    })

    fileStream.on('limit', () => {
      fileLimitReached = true
      uploadLogger.warn('聊天上传文件超过大小限制', {
        filename,
        limit: CHAT_UPLOAD_MAX_SIZE_BYTES,
        received: fileSize,
      })
      writeStream.destroy()
      cleanupTempFile(tempPath)
      pendingWrites--
      handleUploadError(
        CHAT_UPLOAD_TOO_LARGE,
        `文件 ${filename} 超过大小限制 (最大 ${Math.round(CHAT_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024)}MB)`
      )
    })

    fileStream.pipe(writeStream)

    writeStream.on('error', (err) => {
      uploadLogger.error('写入临时文件失败', err)
      cleanupTempFile(tempPath)
      pendingWrites--
      handleUploadError('INTERNAL_ERROR', '文件写入失败')
    })

    writeStream.on('close', () => {
      if (!fileLimitReached && !hasError) {
        uploadedFiles.push({
          originalName: filename,
          mimeType,
          tempPath,
          size: fileSize,
        })
        pendingWrites--
        tryFinalize()
      }
    })
  })

  busboy.on('finish', () => {
    busboyFinished = true
    tryFinalize()
  })

  busboy.on('error', (err: Error) => {
    uploadLogger.error('busboy 解析错误', err)
    cleanupChatFiles(uploadedFiles)
    next(createError('INTERNAL_ERROR', '文件上传解析失败'))
  })

  req.pipe(busboy)
}
