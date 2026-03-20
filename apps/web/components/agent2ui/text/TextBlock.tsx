'use client'

import clsx from 'clsx'
import type { TextData } from '@/types'

/**
 * TextBlock - 纯文本展示组件
 *
 * 用于展示简单的纯文本内容
 */

export interface TextBlockProps {
  data: TextData
  className?: string
}

export function TextBlock({ data, className }: TextBlockProps) {
  return (
    <div
      className={clsx(
        'text-text-primary text-base leading-relaxed',
        'whitespace-pre-wrap break-words',
        className
      )}
    >
      {data.content}
    </div>
  )
}

TextBlock.displayName = 'TextBlock'
