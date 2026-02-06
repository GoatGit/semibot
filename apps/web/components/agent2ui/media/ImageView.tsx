'use client'

import { useState } from 'react'
import clsx from 'clsx'
import { ZoomIn, Download, X } from 'lucide-react'

import type { ImageData } from '@/types'

interface ImageViewProps {
  data: ImageData
  metadata?: Record<string, unknown>
}

/**
 * ImageView - 图片显示组件
 *
 * 功能:
 * - 图片展示
 * - 点击放大预览
 * - 下载功能
 */
export function ImageView({ data }: ImageViewProps) {
  const [isZoomed, setIsZoomed] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  // 使用类型定义的字段名: url, alt, caption, width, height
  const { url, alt = '图片', caption, width, height } = data

  const handleDownload = async () => {
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      const blobUrl = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = alt || 'image'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(blobUrl)
    } catch (error) {
      console.error('[ImageView] 下载失败:', error)
    }
  }

  if (hasError) {
    return (
      <div className="flex items-center justify-center p-8 bg-bg-secondary rounded-lg border border-border-default">
        <p className="text-text-tertiary text-sm">图片加载失败</p>
      </div>
    )
  }

  return (
    <>
      {/* 图片容器 */}
      <div className="relative group">
        {/* 加载指示器 */}
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg-secondary rounded-lg">
            <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* 图片 */}
        <img
          src={url}
          alt={alt}
          width={width}
          height={height}
          className={clsx(
            'max-w-full rounded-lg cursor-pointer transition-opacity',
            isLoading ? 'opacity-0' : 'opacity-100'
          )}
          onClick={() => setIsZoomed(true)}
          onLoad={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false)
            setHasError(true)
          }}
        />

        {/* 操作按钮 */}
        <div
          className={clsx(
            'absolute top-2 right-2 flex gap-1',
            'opacity-0 group-hover:opacity-100 transition-opacity'
          )}
        >
          <button
            onClick={() => setIsZoomed(true)}
            className="p-1.5 bg-bg-overlay/80 rounded-md hover:bg-bg-overlay transition-colors"
            aria-label="放大"
          >
            <ZoomIn size={16} className="text-text-primary" />
          </button>
          <button
            onClick={handleDownload}
            className="p-1.5 bg-bg-overlay/80 rounded-md hover:bg-bg-overlay transition-colors"
            aria-label="下载"
          >
            <Download size={16} className="text-text-primary" />
          </button>
        </div>

        {/* 图片说明 */}
        {caption && (
          <p className="mt-2 text-sm text-text-secondary text-center">{caption}</p>
        )}
      </div>

      {/* 放大预览模态框 */}
      {isZoomed && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
          onClick={() => setIsZoomed(false)}
        >
          {/* 关闭按钮 */}
          <button
            onClick={() => setIsZoomed(false)}
            className="absolute top-4 right-4 p-2 bg-bg-overlay/80 rounded-full hover:bg-bg-overlay transition-colors"
            aria-label="关闭"
          >
            <X size={20} className="text-text-primary" />
          </button>

          {/* 操作按钮 */}
          <div className="absolute bottom-4 flex gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation()
                handleDownload()
              }}
              className="px-4 py-2 bg-bg-overlay/80 rounded-md hover:bg-bg-overlay transition-colors flex items-center gap-2"
            >
              <Download size={16} className="text-text-primary" />
              <span className="text-text-primary text-sm">下载</span>
            </button>
          </div>

          {/* 放大的图片 */}
          <img
            src={url}
            alt={alt}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}

export default ImageView
