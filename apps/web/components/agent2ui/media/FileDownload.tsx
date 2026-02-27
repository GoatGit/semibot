'use client'

import clsx from 'clsx'
import { Download, File, FileText, FileImage, FileVideo, FileAudio, FileArchive } from 'lucide-react'
import { AUTH_DISABLED } from '@/lib/auth-mode'
import { useLocale } from '@/components/providers/LocaleProvider'

interface FileDownloadProps {
  data: {
    url: string
    filename: string
    size?: number
    mimeType?: string
  }
  metadata?: Record<string, unknown>
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number | undefined, unknownLabel: string): string {
  if (!bytes) return unknownLabel

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

/**
 * 根据 MIME 类型获取图标
 */
function getFileIcon(mimeType?: string) {
  if (!mimeType) return File

  if (mimeType.startsWith('image/')) return FileImage
  if (mimeType.startsWith('video/')) return FileVideo
  if (mimeType.startsWith('audio/')) return FileAudio
  if (mimeType.includes('pdf') || mimeType.includes('document') || mimeType.includes('text')) {
    return FileText
  }
  if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('compressed')) {
    return FileArchive
  }

  return File
}

/**
 * FileDownload - 文件下载组件
 *
 * 功能:
 * - 显示文件信息
 * - 点击下载
 */
export function FileDownload({ data }: FileDownloadProps) {
  const { t } = useLocale()
  const { url, filename, size, mimeType } = data
  const IconComponent = getFileIcon(mimeType)

  const resolveDownloadUrl = () => {
    if (/^https?:\/\//i.test(url)) return url
    const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1').replace(/\/$/, '')
    const origin = base.replace(/\/api\/v1$/, '')

    if (url.startsWith('/api/v1/')) {
      return `${origin}${url}`
    }
    if (url.startsWith('/files/')) {
      return `${base}${url}`
    }
    if (url.startsWith('/')) {
      return `${origin}${url}`
    }
    return `${base}/${url.replace(/^\/+/, '')}`
  }

  const handleDownload = async () => {
    const downloadUrl = resolveDownloadUrl()
    try {
      const token = !AUTH_DISABLED && typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
      const response = await fetch(downloadUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!response.ok) {
        throw new Error(t('agent2ui.fileDownload.error.http', { status: response.status }))
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        throw new Error(t('agent2ui.fileDownload.error.invalidResponse'))
      }

      const blob = await response.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      console.error('[FileDownload] 下载失败:', error)
    }
  }

  return (
    <div
      onClick={handleDownload}
      className={clsx(
        'flex items-center gap-3 p-3',
        'bg-bg-secondary rounded-lg border border-border-default',
        'cursor-pointer hover:bg-bg-tertiary hover:border-border-hover',
        'transition-colors'
      )}
    >
      {/* 文件图标 */}
      <div className="flex-shrink-0 p-2 bg-primary-500/10 rounded-md">
        <IconComponent size={24} className="text-primary-400" />
      </div>

      {/* 文件信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">{filename}</p>
        <p className="text-xs text-text-tertiary">{formatFileSize(size, t('agent2ui.fileDownload.unknownSize'))}</p>
      </div>

      {/* 下载按钮 */}
      <button
        className={clsx(
          'flex-shrink-0 p-2 rounded-md',
          'text-text-secondary hover:text-primary-400',
          'hover:bg-primary-500/10 transition-colors'
        )}
        aria-label={t('agent2ui.fileDownload.downloadFile')}
      >
        <Download size={18} />
      </button>
    </div>
  )
}

export default FileDownload
