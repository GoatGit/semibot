'use client'

import clsx from 'clsx'
import { forwardRef } from 'react'

/**
 * Input - 输入框组件
 *
 * 根据 DESIGN_SYSTEM.md 设计
 */

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md' | 'lg'
  error?: boolean
  errorMessage?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      size = 'md',
      error = false,
      errorMessage,
      leftIcon,
      rightIcon,
      className,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <div className="w-full">
        <div className="relative">
          {leftIcon && (
            <div
              className={clsx(
                'absolute left-3 top-1/2 -translate-y-1/2',
                'text-text-tertiary',
                disabled && 'text-text-disabled'
              )}
            >
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            disabled={disabled}
            className={clsx(
              // Base styles
              'w-full rounded-md',
              'bg-bg-surface border',
              'text-text-primary placeholder:text-text-tertiary',
              'transition-all duration-fast ease-out',
              'focus:outline-none',

              // Size styles
              size === 'sm' && 'h-8 px-3 text-sm',
              size === 'md' && 'h-10 px-3 text-base',
              size === 'lg' && 'h-12 px-4 text-lg',

              // Icon padding
              leftIcon && (size === 'sm' ? 'pl-9' : size === 'lg' ? 'pl-12' : 'pl-10'),
              rightIcon && (size === 'sm' ? 'pr-9' : size === 'lg' ? 'pr-12' : 'pr-10'),

              // State styles
              !error && [
                'border-border-default',
                'hover:border-border-strong',
                'focus:border-primary-500 focus:shadow-glow-primary',
              ],
              error && [
                'border-error-500',
                'focus:border-error-500 focus:shadow-glow-error',
              ],
              disabled && [
                'bg-bg-base text-text-disabled cursor-not-allowed',
                'border-border-subtle',
              ],

              className
            )}
            {...props}
          />
          {rightIcon && (
            <div
              className={clsx(
                'absolute right-3 top-1/2 -translate-y-1/2',
                'text-text-tertiary',
                disabled && 'text-text-disabled'
              )}
            >
              {rightIcon}
            </div>
          )}
        </div>
        {error && errorMessage && (
          <p className="mt-1.5 text-sm text-error-500">{errorMessage}</p>
        )}
      </div>
    )
  }
)

Input.displayName = 'Input'
