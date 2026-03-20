import React from 'react'
import { cn } from '@/lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'error' | 'outline'
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const variantStyles = {
      default: 'bg-neutral-500/10 text-text-secondary border-border-default',
      success: 'bg-success-500/10 text-success-500 border-success-500/20',
      warning: 'bg-warning-500/10 text-warning-500 border-warning-500/20',
      error: 'bg-error-500/10 text-error-500 border-error-500/20',
      outline: 'bg-transparent text-text-secondary border-border-default',
    }

    return (
      <span
        ref={ref}
        className={cn(
          'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors',
          variantStyles[variant],
          className
        )}
        {...props}
      />
    )
  }
)

Badge.displayName = 'Badge'
