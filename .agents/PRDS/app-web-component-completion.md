# PRD: 前端组件补全

## 概述

前端组件库不完整，存在 TODO 未实现的组件，需要补全关键组件。

## 问题描述

### ComponentRegistry 未完成

```typescript
// components/agent2ui/ComponentRegistry.tsx:48-49
image: TextBlock, // TODO: 实现 ImageView 组件
file: TextBlock,  // TODO: 实现 FileDownload 组件
```

**影响：**
- 图片显示为纯文本
- 文件下载功能不可用

### 基础组件缺失

当前只有 3 个基础 UI 组件：
- Button ✅
- Input ✅
- Card ✅

缺少：
- Select
- Checkbox
- Radio
- Modal
- Dropdown
- Tooltip
- Tabs
- Table

## 目标

1. 实现 ImageView 和 FileDownload 组件
2. 补充常用基础组件
3. 建立组件文档

## 技术方案

### 1. ImageView 组件

```tsx
// components/agent2ui/media/ImageView.tsx
'use client'

import { useState } from 'react'
import Image from 'next/image'

interface ImageViewProps {
  src: string
  alt?: string
  caption?: string
  width?: number
  height?: number
}

export function ImageView({ src, alt, caption, width, height }: ImageViewProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  if (error) {
    return (
      <div className="flex items-center justify-center bg-surface-secondary rounded-lg p-8">
        <div className="text-center text-text-tertiary">
          <span className="text-2xl">🖼️</span>
          <p className="mt-2 text-sm">图片加载失败</p>
        </div>
      </div>
    )
  }

  return (
    <figure className="relative">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface-secondary rounded-lg">
          <div className="animate-pulse">加载中...</div>
        </div>
      )}
      <Image
        src={src}
        alt={alt || '图片'}
        width={width || 800}
        height={height || 600}
        className={`rounded-lg transition-opacity ${loading ? 'opacity-0' : 'opacity-100'}`}
        onLoad={() => setLoading(false)}
        onError={() => setError(true)}
      />
      {caption && (
        <figcaption className="mt-2 text-center text-sm text-text-tertiary">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
```

### 2. FileDownload 组件

```tsx
// components/agent2ui/media/FileDownload.tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'

interface FileDownloadProps {
  url: string
  filename: string
  size?: number
  mimeType?: string
}

const FILE_ICONS: Record<string, string> = {
  'application/pdf': '📄',
  'application/zip': '📦',
  'text/plain': '📝',
  'image/': '🖼️',
  'video/': '🎬',
  'audio/': '🎵',
  default: '📎',
}

function getFileIcon(mimeType?: string): string {
  if (!mimeType) return FILE_ICONS.default
  for (const [type, icon] of Object.entries(FILE_ICONS)) {
    if (mimeType.startsWith(type)) return icon
  }
  return FILE_ICONS.default
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileDownload({ url, filename, size, mimeType }: FileDownloadProps) {
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const response = await fetch(url)
      const blob = await response.blob()
      const downloadUrl = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = downloadUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      window.URL.revokeObjectURL(downloadUrl)
    } catch (error) {
      console.error('下载失败:', error)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex items-center gap-3 p-4 bg-surface-secondary rounded-lg border border-border-secondary">
      <span className="text-2xl">{getFileIcon(mimeType)}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-text-primary truncate">{filename}</p>
        {size && (
          <p className="text-sm text-text-tertiary">{formatFileSize(size)}</p>
        )}
      </div>
      <Button
        size="sm"
        variant="secondary"
        loading={downloading}
        onClick={handleDownload}
      >
        下载
      </Button>
    </div>
  )
}
```

### 3. 更新 ComponentRegistry

```typescript
// components/agent2ui/ComponentRegistry.tsx
import { ImageView } from './media/ImageView'
import { FileDownload } from './media/FileDownload'

export const componentRegistry = {
  // ... existing components
  image: ImageView,
  file: FileDownload,
}
```

### 4. 基础组件 - Modal

```tsx
// components/ui/Modal.tsx
'use client'

import { Fragment, ReactNode } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { Button } from './Button'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  return (
    <Transition show={open} as={Fragment}>
      <Dialog onClose={onClose} className="relative z-50">
        {/* Backdrop */}
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
        </Transition.Child>

        {/* Modal */}
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <Dialog.Panel
              className={`w-full ${sizeClasses[size]} bg-surface-primary rounded-xl shadow-xl`}
            >
              {title && (
                <Dialog.Title className="px-6 py-4 border-b border-border-secondary font-semibold text-text-primary">
                  {title}
                </Dialog.Title>
              )}
              <div className="p-6">{children}</div>
              {footer && (
                <div className="px-6 py-4 border-t border-border-secondary flex justify-end gap-2">
                  {footer}
                </div>
              )}
            </Dialog.Panel>
          </Transition.Child>
        </div>
      </Dialog>
    </Transition>
  )
}
```

### 5. 基础组件 - Select

```tsx
// components/ui/Select.tsx
'use client'

import { forwardRef, SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean
  errorMessage?: string
  options: { value: string; label: string }[]
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, error, errorMessage, options, placeholder, ...props }, ref) => {
    return (
      <div className="w-full">
        <select
          ref={ref}
          className={cn(
            'w-full px-3 py-2 rounded-lg border transition-all',
            'bg-surface-primary text-text-primary',
            'focus:outline-none focus:ring-2 focus:ring-primary-500',
            error
              ? 'border-red-500 focus:ring-red-500'
              : 'border-border-secondary',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className
          )}
          {...props}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {errorMessage && (
          <p className="mt-1 text-sm text-red-500">{errorMessage}</p>
        )}
      </div>
    )
  }
)

Select.displayName = 'Select'
```

## 验收标准

- [ ] ImageView 正确显示图片和加载状态
- [ ] FileDownload 支持文件下载
- [ ] Modal 支持焦点陷阱和键盘导航
- [ ] Select 支持错误状态显示
- [ ] 所有组件有 TypeScript 类型定义
- [ ] 单元测试覆盖率 > 80%

## 优先级

**P1 - 高优先级**

## 相关文件

- `apps/web/src/components/agent2ui/media/ImageView.tsx` (新建)
- `apps/web/src/components/agent2ui/media/FileDownload.tsx` (新建)
- `apps/web/src/components/agent2ui/ComponentRegistry.tsx`
- `apps/web/src/components/ui/Modal.tsx` (新建)
- `apps/web/src/components/ui/Select.tsx` (新建)
