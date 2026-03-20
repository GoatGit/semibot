'use client'

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Download, File, FileText, FileImage, FileVideo, FileAudio, FileArchive, PanelRightOpen } from 'lucide-react'
import { AUTH_DISABLED } from '@/lib/auth-mode'
import { useLocale } from '@/components/providers/LocaleProvider'
import { getDirectApiBaseUrlForBrowser } from '@/lib/api'
import { useLayoutStore } from '@/stores/layoutStore'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'

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
  const { openDetailContent, detailCanvasMode, detailContent } = useLayoutStore()
  const [markdownContent, setMarkdownContent] = useState('')
  const [previewError, setPreviewError] = useState<string | null>(null)

  const isMarkdownFile = useMemo(() => {
    const lowerName = filename.toLowerCase()
    const lowerMime = String(mimeType || '').toLowerCase()
    return lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerMime.includes('markdown')
  }, [filename, mimeType])

  const isJsonFile = useMemo(() => {
    const lowerName = filename.toLowerCase()
    const lowerMime = String(mimeType || '').toLowerCase()
    return lowerName.endsWith('.json') || lowerMime.includes('json')
  }, [filename, mimeType])

  const isPreviewable = isMarkdownFile || isJsonFile

  const resolvedDownloadUrl = useMemo(() => {
    if (/^https?:\/\//i.test(url)) return url
    const base = getDirectApiBaseUrlForBrowser().replace(/\/$/, '')
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
  }, [url])

  const isOpenedInDetail =
    isPreviewable &&
    detailCanvasMode !== 'collapsed' &&
    detailContent?.kind === 'markdown' &&
    (detailContent.sourceUrl === resolvedDownloadUrl || detailContent.filename === filename)

  useEffect(() => {
    if (!isPreviewable) return
    let cancelled = false

    const loadMarkdown = async () => {
      try {
        const token = !AUTH_DISABLED && typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
        const response = await fetch(resolvedDownloadUrl, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        })
        if (!response.ok) {
          throw new Error(t('agent2ui.fileDownload.error.http', { status: response.status }))
        }
        const text = await response.text()
        if (cancelled) return

        if (isJsonFile) {
          try {
            const obj = JSON.parse(text)
            setMarkdownContent("```json\n" + JSON.stringify(obj, null, 2) + "\n```")
          } catch {
            setMarkdownContent("```json\n" + text + "\n```")
          }
        } else {
          setMarkdownContent(text)
        }
        setPreviewError(null)
      } catch (error) {
        if (cancelled) return
        setPreviewError(error instanceof Error ? error.message : t('error.unknown'))
      }
    }

    void loadMarkdown()
    return () => {
      cancelled = true
    }
  }, [isPreviewable, isJsonFile, resolvedDownloadUrl, t])

  const handleDownload = async () => {
    try {
      const token = !AUTH_DISABLED && typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
      const response = await fetch(resolvedDownloadUrl, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      })
      if (!response.ok) {
        throw new Error(t('agent2ui.fileDownload.error.http', { status: response.status }))
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json') && !isJsonFile) {
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

  const handleOpenDetail = () => {
    if (!isPreviewable || !markdownContent) return
    openDetailContent({
      kind: 'markdown',
      title: filename,
      filename,
      sourceUrl: resolvedDownloadUrl,
      content: markdownContent,
    })
  }

  return (
    <div
      className={clsx(
        'rounded-lg border border-border-default bg-bg-secondary overflow-hidden',
        'transition-colors'
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <div className="flex-shrink-0 p-2 bg-primary-500/10 rounded-md">
          <IconComponent size={24} className="text-primary-400" />
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary truncate">{filename}</p>
          <p className="text-xs text-text-tertiary">{formatFileSize(size, t('agent2ui.fileDownload.unknownSize'))}</p>
        </div>

        {isPreviewable && markdownContent && (
          <button
            onClick={handleOpenDetail}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs',
              'text-primary-300 hover:bg-primary-500/10 transition-colors'
            )}
            aria-label={t('detailCanvas.expand')}
          >
            <PanelRightOpen size={16} />
            <span>{t('agent2ui.fileDownload.openInDetail')}</span>
          </button>
        )}

        <button
          onClick={handleDownload}
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

      {isPreviewable && (
        <div className="border-t border-border-subtle bg-bg-surface px-4 py-4">
          {markdownContent ? (
            isOpenedInDetail ? (
              <div className="rounded-xl border border-primary-500/20 bg-primary-500/8 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.08em] text-primary-300">
                      {t('agent2ui.fileDownload.markdownPreview')}
                    </div>
                    <div className="mt-1 text-sm text-text-secondary">
                      {t('agent2ui.fileDownload.openInDetail')}
                    </div>
                  </div>
                  <button
                    onClick={handleOpenDetail}
                    className={clsx(
                      'flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs',
                      'text-primary-300 hover:bg-primary-500/10 transition-colors'
                    )}
                  >
                    <PanelRightOpen size={16} />
                    <span>{t('agent2ui.fileDownload.openInDetail')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="cursor-pointer rounded-xl border border-border-subtle bg-bg-elevated px-4 py-4 hover:border-border-hover"
                onClick={handleOpenDetail}
              >
                <div className="mb-3 text-xs uppercase tracking-[0.08em] text-text-tertiary">
                  {t('agent2ui.fileDownload.markdownPreview')}
                </div>
                <div className="max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
                  <MarkdownBlock data={{ content: markdownContent }} />
                </div>
              </div>
            )
          ) : previewError ? (
            <div className="text-xs text-error-400">{previewError}</div>
          ) : (
            <div className="text-xs text-text-tertiary">{t('loading.contentLoading')}</div>
          )}
        </div>
      )}
    </div>
  )
}

export default FileDownload
