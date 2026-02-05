'use client'

import { useState, useCallback } from 'react'
import clsx from 'clsx'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy, FileCode } from 'lucide-react'
import type { CodeData } from '@/types'

/**
 * CodeBlock - 代码块展示组件
 *
 * 使用 react-syntax-highlighter 进行语法高亮
 * 支持复制代码、显示语言和文件名
 */

export interface CodeBlockProps {
  data: CodeData
  className?: string
}

export function CodeBlock({ data, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(data.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy code:', err)
    }
  }, [data.code])

  // 语言映射，用于显示和高亮
  const languageMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash',
    yml: 'yaml',
    md: 'markdown',
  }

  const displayLanguage = data.language || 'text'
  const highlightLanguage = languageMap[displayLanguage] || displayLanguage

  return (
    <div
      className={clsx(
        'rounded-lg overflow-hidden',
        'border border-border-subtle',
        'bg-bg-elevated',
        className
      )}
    >
      {/* 头部：语言/文件名 + 复制按钮 */}
      <div
        className={clsx(
          'flex items-center justify-between',
          'px-4 py-2',
          'bg-bg-surface border-b border-border-subtle'
        )}
      >
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <FileCode className="w-4 h-4" />
          {data.filename ? (
            <span className="font-mono">{data.filename}</span>
          ) : (
            <span>{displayLanguage}</span>
          )}
        </div>
        <button
          onClick={handleCopy}
          className={clsx(
            'flex items-center gap-1.5 px-2 py-1',
            'text-xs text-text-secondary',
            'rounded transition-colors duration-fast',
            'hover:text-text-primary hover:bg-interactive-hover',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
          )}
          aria-label={copied ? '已复制' : '复制代码'}
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-success-500" />
              <span>已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>复制</span>
            </>
          )}
        </button>
      </div>

      {/* 代码区域 */}
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={highlightLanguage}
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: '1rem',
            background: 'transparent',
            fontSize: '0.875rem',
            lineHeight: 1.6,
          }}
          codeTagProps={{
            style: {
              fontFamily: 'var(--font-mono)',
            },
          }}
          showLineNumbers={data.code.split('\n').length > 5}
          lineNumberStyle={{
            minWidth: '2.5rem',
            paddingRight: '1rem',
            color: 'var(--color-neutral-600)',
            userSelect: 'none',
          }}
        >
          {data.code}
        </SyntaxHighlighter>
      </div>
    </div>
  )
}

CodeBlock.displayName = 'CodeBlock'
