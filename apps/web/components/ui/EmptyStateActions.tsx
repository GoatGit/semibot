'use client'

interface EmptyStateActionsProps {
  message: string
  actions?: React.ReactNode
  className?: string
}

export function EmptyStateActions({ message, actions, className }: EmptyStateActionsProps) {
  return (
    <div className={['rounded-md border border-border-subtle bg-bg-surface px-4 py-4', className].filter(Boolean).join(' ')}>
      <p className="text-sm text-text-secondary">{message}</p>
      {actions ? <div className="mt-3 flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

