/**
 * 文件上传中间件
 *
 * 基于 busboy 的流式 multipart/form-data 解析
 * 支持文件大小限制、扩展名校验、临时文件管理
 */

import type { Request, Response, NextFunction } from 'express'
import Busboy from 'busboy'
import { createWriteStream } from 'fs'
import fs from 'fs-extra'
import * as path from 'path'
import * as crypto from 'crypto'
import { createError } from './errorHandler'
import {
  SKILL_MAX_SIZE_BYTES,
  SKILL_UPLOAD_TEMP_DIR,
  SKILL_UPLOAD_ALLOWED_EXTENSIONS,
} from '../constants/config'
import {
  SKILL_UPLOAD_TOO_LARGE,
  SKILL_UPLOAD_INVALID_TYPE,
  SKILL_UPLOAD_NO_FILE,
} from '../constants/errorCodes'
import { createLogger } from '../lib/logger'

const uploadLogger = createLogger('upload')

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface UploadedFile {
  fieldName: string
  originalName: string
  mimeType: string
  tempPath: string
  size: number
}

export interface UploadRequest extends Request {
  uploadedFile?: UploadedFile
  uploadFields?: Record<string, string>
}

// ═══════════════════════════════════════════════════���═══════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 检查文件扩展名是否允许
 */
function isAllowedExtension(filename: string): boolean {
  const lowerName = filename.toLowerCase()
  return SKILL_UPLOAD_ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))
}

/**
 * 生成临时文件路径
 */
function generateTempPath(originalName: string): string {
  const randomId = crypto.randomBytes(16).toString('hex')
  const ext = originalName.toLowerCase().endsWith('.tar.gz')
    ? '.tar.gz'
    : path.extname(originalName)
  return path.join(SKILL_UPLOAD_TEMP_DIR, `${randomId}${ext}`)
}

/**
 * 安全清理临时文件
 */
async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath)
    }
  } catch (err) {
    uploadLogger.warn('清理临时文件失败', { filePath, error: (err as Error).message })
  }
}

// ═══════════════════════════════════════════════════════════════
// 中间件
// ═════════════════════════════════���═════════════════════════════

/**
 * 文件上传中间件
 *
 * 流式接收 multipart/form-data，写入临时文件
 * 实时检查文件大小，超限立即中断并清理
 */
export function handleFileUpload(req: UploadRequest, _res: Response, next: NextFunction): void {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('multipart/form-data')) {
    next(createError(SKILL_UPLOAD_NO_FILE, '请求必须为 multipart/form-data 格式'))
    return
  }

  uploadLogger.info('开始处理文件��传', {
    contentType,
    contentLength: req.headers['content-length'],
  })

  // 确保临时目录存在
  fs.ensureDirSync(SKILL_UPLOAD_TEMP_DIR)

  const busboy = Busboy({
    headers: req.headers,
    limits: {
      fileSize: SKILL_MAX_SIZE_BYTES,
      files: 1,
    },
  })

  let fileReceived = false
  let tempPath = ''
  let fileSize = 0
  let fileLimitReached = false
  let writeFinished = false
  let busboyFinished = false
  let fileInfo: { fieldName: string; originalName: string; mimeType: string } | null = null
  const fields: Record<string, string> = {}

  // 当文件写入和 busboy 解析都完成时，调用 next()
  function tryFinalize() {
    if (!busboyFinished || (fileReceived && !writeFinished && !fileLimitReached)) {
      return
    }

    if (fileLimitReached) {
      next(createError(SKILL_UPLOAD_TOO_LARGE, `文件大小超过限制 (最大 ${Math.round(SKILL_MAX_SIZE_BYTES / 1024 / 1024)}MB)`))
      return
    }

    if (!fileReceived) {
      next(createError(SKILL_UPLOAD_NO_FILE, '未检测到上传文件'))
      return
    }

    if (fileInfo) {
      req.uploadedFile = {
        fieldName: fileInfo.fieldName,
        originalName: fileInfo.originalName,
        mimeType: fileInfo.mimeType,
        tempPath,
        size: fileSize,
      }
    }

    req.uploadFields = fields
    next()
  }

  busboy.on('field', (fieldName: string, value: string) => {
    uploadLogger.debug('收到字段', { fieldName, value: value.slice(0, 100) })
    fields[fieldName] = value
  })

  busboy.on('file', (fieldName: string, fileStream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
    const { filename, mimeType } = info
    uploadLogger.info('收到文件', { fieldName, filename, mimeType })

    if (!filename) {
      fileStream.resume()
      return
    }

    // 校验扩展名
    if (!isAllowedExtension(filename)) {
      fileStream.resume()
      next(createError(SKILL_UPLOAD_INVALID_TYPE, `不支持的文件类型: ${filename}，仅支持 ${SKILL_UPLOAD_ALLOWED_EXTENSIONS.join(', ')}`))
      return
    }

    fileReceived = true
    fileInfo = { fieldName, originalName: filename, mimeType }
    tempPath = generateTempPath(filename)
    const writeStream = createWriteStream(tempPath)

    fileStream.on('data', (chunk: Buffer) => {
      fileSize += chunk.length
    })

    fileStream.on('limit', () => {
      fileLimitReached = true
      uploadLogger.warn('上传文件超过大小限制', {
        filename,
        limit: SKILL_MAX_SIZE_BYTES,
        received: fileSize,
      })
      writeStream.destroy()
      cleanupTempFile(tempPath)
      tryFinalize()
    })

    fileStream.pipe(writeStream)

    writeStream.on('error', (err) => {
      uploadLogger.error('写入临时文件失败', err)
      cleanupTempFile(tempPath)
      next(createError('INTERNAL_ERROR', '文件写入失败'))
    })

    writeStream.on('close', () => {
      if (!fileLimitReached) {
        writeFinished = true
        uploadLogger.debug('文件写入完成', { tempPath, fileSize })
        tryFinalize()
      }
    })
  })

  busboy.on('finish', () => {
    uploadLogger.info('busboy finish', { fileReceived, fileLimitReached, writeFinished, fields: Object.keys(fields) })
    busboyFinished = true
    tryFinalize()
  })

  busboy.on('error', (err: Error) => {
    uploadLogger.error('busboy 解析错误', err)
    if (tempPath) {
      cleanupTempFile(tempPath)
    }
    next(createError('INTERNAL_ERROR', '文件上传解析失败'))
  })

  req.pipe(busboy)
}
