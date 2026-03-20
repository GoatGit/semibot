'use client'

import { AlertCircle, X } from 'lucide-react'

interface InlineErrorAlertProps {
  message: string
  onClose?: () => void
  className?: string
}

export function InlineErrorAlert({ message, onClose, className }: InlineErrorAlertProps) {
  return (
    <div className={['rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500', className].filter(Boolean).join(' ')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <AlertCircle size={16} />
          <span className="break-words">{message}</span>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-error-500/70 hover:text-error-500"
            aria-label="Close error"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

