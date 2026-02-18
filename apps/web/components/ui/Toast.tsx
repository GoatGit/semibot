'use client'

import clsx from 'clsx'
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useToastStore } from '@/stores/toastStore'
import type { Toast } from '@/stores/toastStore'

const ICON_MAP = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
}

const STYLE_MAP = {
  success: 'border-success-500/30 bg-success-500/10 text-success-500',
  error: 'border-error-500/30 bg-error-500/10 text-error-500',
  warning: 'border-warning-500/30 bg-warning-500/10 text-warning-500',
  info: 'border-info-500/30 bg-info-500/10 text-info-500',
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  const Icon = ICON_MAP[toast.type]

  return (
    <div
      className={clsx(
        'flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg',
        'bg-bg-surface backdrop-blur-sm',
        'animate-slide-in-right',
        'min-w-[280px] max-w-[400px]',
        STYLE_MAP[toast.type]
      )}
      role="alert"
    >
      <Icon size={18} className="flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{toast.title}</p>
        {toast.description && (
          <p className="text-xs text-text-secondary mt-0.5">{toast.description}</p>
        )}
      </div>
      <button
        onClick={onRemove}
        className="flex-shrink-0 p-0.5 rounded text-text-tertiary hover:text-text-primary transition-colors"
        aria-label="关闭"
      >
        <X size={14} />
      </button>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onRemove={() => removeToast(t.id)} />
      ))}
    </div>
  )
}
