'use client'

import clsx from 'clsx'
import { useEffect, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl'
  closeOnBackdrop?: boolean
  closeOnEsc?: boolean
  showCloseButton?: boolean
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  showCloseButton = true,
}: ModalProps) {
  const { t } = useLocale()
  const overlayRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // ESC 关闭
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === 'Escape') {
        onClose()
      }
    },
    [closeOnEsc, onClose]
  )

  useEffect(() => {
    if (!open) return
    document.addEventListener('keydown', handleKeyDown)
    // 阻止背景滚动
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = prev
    }
  }, [open, handleKeyDown])

  useEffect(() => {
    if (!open || !closeOnBackdrop) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (contentRef.current && !contentRef.current.contains(target)) {
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, closeOnBackdrop, onClose])

  // 焦点陷阱：打开时聚焦到内容区
  useEffect(() => {
    if (open && contentRef.current) {
      contentRef.current.focus()
    }
  }, [open])

  if (!open) return null

  const widthClass = {
    sm: 'sm:max-w-md',
    md: 'sm:max-w-xl',
    lg: 'sm:max-w-2xl',
    xl: 'sm:max-w-4xl',
  }[maxWidth]

  return (
    <div
      ref={overlayRef}
      className={clsx(
        'fixed inset-0 z-50 flex items-stretch justify-end',
        'pointer-events-none',
        'animate-fade-in'
      )}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === overlayRef.current) {
          onClose()
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        className={clsx(
          'h-full w-full',
          'rounded-none sm:rounded-l-xl',
          'bg-bg-surface border border-border-default',
          'shadow-xl',
          'animate-scale-in',
          'focus:outline-none',
          'overflow-hidden',
          'pointer-events-auto',
          widthClass
        )}
      >
        <div className="flex h-full min-h-0 flex-col">
          {/* Header */}
          <div className="flex items-start justify-between border-b border-border-subtle p-6">
            <div>
              <h3 id="modal-title" className="text-lg font-semibold text-text-primary">
                {title}
              </h3>
              {description && (
                <p className="text-sm text-text-secondary mt-1">{description}</p>
              )}
            </div>
            {showCloseButton && (
              <button
                onClick={onClose}
                className={clsx(
                  'p-1.5 rounded-md -mt-1 -mr-1',
                  'text-text-tertiary hover:text-text-primary hover:bg-interactive-hover',
                  'transition-colors duration-fast'
                )}
                aria-label={t('common.close')}
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>

          {/* Footer */}
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border-subtle px-6 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
