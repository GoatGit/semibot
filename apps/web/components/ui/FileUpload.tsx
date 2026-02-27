'use client'

import { useCallback, useRef, useState } from 'react'
import clsx from 'clsx'
import { FileArchive, Upload, X } from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'

interface FileUploadProps {
  /** 接受的文件类型 (MIME 或扩展名) */
  accept?: string
  /** 最大文件大小 (字节) */
  maxSize?: number
  /** 允许的扩展名列表 (如 ['.zip', '.tar.gz', '.tgz']) */
  allowedExtensions?: string[]
  /** 选中文件回调 */
  onFileSelect: (file: File | null) => void
  /** 错误回调 */
  onError?: (message: string) => void
  /** 当前选中的文件 */
  value?: File | null
  /** 错误信息 */
  error?: string
  /** 是否禁用 */
  disabled?: boolean
  /** 提示文字 */
  hint?: string
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function getFileExtension(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  const lastDot = lower.lastIndexOf('.')
  return lastDot >= 0 ? lower.slice(lastDot) : ''
}

export function FileUpload({
  accept,
  maxSize,
  allowedExtensions,
  onFileSelect,
  onError,
  value,
  error,
  disabled = false,
  hint,
}: FileUploadProps) {
  const { t } = useLocale()
  const [isDragOver, setIsDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const validateFile = useCallback(
    (file: File): string | null => {
      if (maxSize && file.size > maxSize) {
        return t('fileUpload.error.maxSize', {
          size: formatFileSize(file.size),
          max: formatFileSize(maxSize),
        })
      }

      if (allowedExtensions && allowedExtensions.length > 0) {
        const ext = getFileExtension(file.name)
        if (!allowedExtensions.includes(ext)) {
          return t('fileUpload.error.invalidType', {
            ext,
            allowed: allowedExtensions.join(', '),
          })
        }
      }

      return null
    },
    [allowedExtensions, maxSize, t]
  )

  const handleFile = useCallback(
    (file: File) => {
      const validationError = validateFile(file)
      if (validationError) {
        onError?.(validationError)
        onFileSelect(null)
        return
      }
      onError?.('')
      onFileSelect(file)
    },
    [validateFile, onFileSelect, onError]
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!disabled) {
        setIsDragOver(true)
      }
    },
    [disabled]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      if (disabled) return

      const files = e.dataTransfer.files
      if (files.length > 0) {
        handleFile(files[0])
      }
    },
    [disabled, handleFile]
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        handleFile(files[0])
      }
      // 重置 input 以允许重复选择同一文件
      if (inputRef.current) {
        inputRef.current.value = ''
      }
    },
    [handleFile]
  )

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onFileSelect(null)
      onError?.('')
    },
    [onFileSelect, onError]
  )

  const handleClick = useCallback(() => {
    if (!disabled) {
      inputRef.current?.click()
    }
  }, [disabled])

  return (
    <div className="space-y-2">
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={clsx(
          'relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 cursor-pointer transition-all duration-fast',
          disabled && 'opacity-50 cursor-not-allowed',
          error && 'border-error-500 bg-error-500/5',
          isDragOver && !disabled && 'border-primary-500 bg-primary-500/5',
          !error && !isDragOver && 'border-border-default bg-bg-surface hover:border-primary-400 hover:bg-bg-elevated'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={handleInputChange}
          disabled={disabled}
          className="hidden"
        />

        {value ? (
          <div className="flex items-center gap-3 w-full">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary-500/10 flex items-center justify-center">
              <FileArchive className="w-5 h-5 text-primary-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{value.name}</p>
              <p className="text-xs text-text-tertiary">{formatFileSize(value.size)}</p>
            </div>
            <button
              type="button"
              onClick={handleClear}
              disabled={disabled}
              className="flex-shrink-0 p-1 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <>
            <Upload className="w-8 h-8 text-text-tertiary mb-2" />
            <p className="text-sm text-text-secondary">
              {t('fileUpload.dropOr')}{' '}
              <span className="text-primary-500 font-medium">{t('fileUpload.clickSelect')}</span>
            </p>
            {hint && <p className="text-xs text-text-tertiary mt-1">{hint}</p>}
          </>
        )}
      </div>

      {error && <p className="text-xs text-error-500">{error}</p>}
    </div>
  )
}
