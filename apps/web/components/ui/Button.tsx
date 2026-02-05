'use client'

import clsx from 'clsx'
import { forwardRef } from 'react'

/**
 * Button - 按钮组件
 *
 * 根据 DESIGN_SYSTEM.md 设计:
 * - 4 个变体: primary, secondary, tertiary, destructive
 * - 4 个尺寸: xs, sm, md, lg
 */

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive'
  size?: 'xs' | 'sm' | 'md' | 'lg'
  loading?: boolean
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  children: React.ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      disabled = false,
      leftIcon,
      rightIcon,
      children,
      className,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading

    return (
      <button
        ref={ref}
        disabled={isDisabled}
        className={clsx(
          // Base styles
          'inline-flex items-center justify-center gap-2',
          'font-medium rounded-md',
          'transition-all duration-fast ease-out',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'focus-visible:ring-primary-500 focus-visible:ring-offset-bg-base',
          'disabled:cursor-not-allowed',

          // Variant styles
          variant === 'primary' && [
            'bg-primary-500 text-neutral-950',
            'hover:bg-primary-400',
            'active:bg-primary-600 active:scale-[0.98]',
            'disabled:bg-neutral-700 disabled:text-neutral-500',
          ],
          variant === 'secondary' && [
            'bg-transparent text-text-primary',
            'border border-border-default',
            'hover:bg-interactive-hover hover:border-border-strong',
            'active:bg-interactive-active',
            'disabled:bg-transparent disabled:text-text-disabled disabled:border-border-subtle',
          ],
          variant === 'tertiary' && [
            'bg-transparent text-text-secondary',
            'hover:text-text-primary hover:bg-interactive-hover',
            'active:bg-interactive-active',
            'disabled:text-text-disabled',
          ],
          variant === 'destructive' && [
            'bg-error-500 text-neutral-0',
            'hover:bg-error-600',
            'active:bg-error-600 active:scale-[0.98]',
            'disabled:bg-neutral-700 disabled:text-neutral-500',
          ],

          // Size styles
          size === 'xs' && 'h-6 px-2 text-xs',
          size === 'sm' && 'h-8 px-3 text-sm',
          size === 'md' && 'h-10 px-4 text-base',
          size === 'lg' && 'h-12 px-6 text-lg',

          className
        )}
        {...props}
      >
        {loading ? (
          <LoadingSpinner size={size} />
        ) : (
          <>
            {leftIcon && <span className="flex-shrink-0">{leftIcon}</span>}
            {children}
            {rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
          </>
        )}
      </button>
    )
  }
)

Button.displayName = 'Button'

interface LoadingSpinnerProps {
  size: 'xs' | 'sm' | 'md' | 'lg'
}

function LoadingSpinner({ size }: LoadingSpinnerProps) {
  const spinnerSize = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  }[size]

  return (
    <svg
      className={clsx(spinnerSize, 'animate-spin')}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}
