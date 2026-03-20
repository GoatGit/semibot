/**
 * 文件上传管理 Hook
 *
 * 管理聊天中待上传的文件列表，支持校验、预览、移除
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import {
  CHAT_UPLOAD_MAX_FILES,
  CHAT_UPLOAD_MAX_SIZE_BYTES,
  CHAT_UPLOAD_ALLOWED_EXTENSIONS,
} from '@/constants/config'

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

export interface PendingFile {
  id: string
  file: File
  preview?: string
}

export interface UseFileUploadReturn {
  files: PendingFile[]
  addFiles: (fileList: FileList | File[]) => string | null
  removeFile: (id: string) => void
  clearFiles: () => void
  hasFiles: boolean
}

// ═══════════════════════════════════════════════════════════════
// Hook 实现
// ═══════════════════════════════════════════════════════════════

export function useFileUpload(): UseFileUploadReturn {
  const [files, setFiles] = useState<PendingFile[]>([])
  const previewUrlsRef = useRef<string[]>([])

  // 组件卸载时 revoke 所有预览 URL
  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) {
        URL.revokeObjectURL(url)
      }
    }
  }, [])

  const addFiles = useCallback((fileList: FileList | File[]): string | null => {
    const newFiles = Array.from(fileList)

    // 校验总数量
    const totalCount = files.length + newFiles.length
    if (totalCount > CHAT_UPLOAD_MAX_FILES) {
      return `最多上传 ${CHAT_UPLOAD_MAX_FILES} 个文件`
    }

    // 逐个校验
    for (const file of newFiles) {
      // 校验大小
      if (file.size > CHAT_UPLOAD_MAX_SIZE_BYTES) {
        return `文件 ${file.name} 超过 ${Math.round(CHAT_UPLOAD_MAX_SIZE_BYTES / 1024 / 1024)}MB 限制`
      }

      // 校验扩展名
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      if (!CHAT_UPLOAD_ALLOWED_EXTENSIONS.includes(ext)) {
        return `不支持的文件类型: ${file.name}`
      }
    }

    const pending: PendingFile[] = newFiles.map((file) => {
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      let preview: string | undefined

      if (file.type.startsWith('image/')) {
        preview = URL.createObjectURL(file)
        previewUrlsRef.current.push(preview)
      }

      return { id, file, preview }
    })

    setFiles((prev) => [...prev, ...pending])
    return null
  }, [files.length])

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id)
      if (target?.preview) {
        URL.revokeObjectURL(target.preview)
        previewUrlsRef.current = previewUrlsRef.current.filter((u) => u !== target.preview)
      }
      return prev.filter((f) => f.id !== id)
    })
  }, [])

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      for (const f of prev) {
        if (f.preview) {
          URL.revokeObjectURL(f.preview)
        }
      }
      previewUrlsRef.current = []
      return []
    })
  }, [])

  return {
    files,
    addFiles,
    removeFile,
    clearFiles,
    hasFiles: files.length > 0,
  }
}
