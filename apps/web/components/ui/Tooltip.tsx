'use client'

import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState } from 'react'

interface TooltipProps {
  content: string
  side?: 'top' | 'right' | 'bottom' | 'left'
  delay?: number
  triggerClassName?: string
  children: React.ReactNode
}

export function Tooltip({ content, side = 'top', delay = 300, triggerClassName, children }: TooltipProps) {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const [actualSide, setActualSide] = useState(side)
  const triggerRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (!trigger || !tooltip) return

    const triggerRect = trigger.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    const gap = 8

    let resolvedSide = side
    let top = 0
    let left = 0

    const calc = (s: typeof side) => {
      switch (s) {
        case 'top':
          top = triggerRect.top - tooltipRect.height - gap
          left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
          break
        case 'bottom':
          top = triggerRect.bottom + gap
          left = triggerRect.left + (triggerRect.width - tooltipRect.width) / 2
          break
        case 'left':
          top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2
          left = triggerRect.left - tooltipRect.width - gap
          break
        case 'right':
          top = triggerRect.top + (triggerRect.height - tooltipRect.height) / 2
          left = triggerRect.right + gap
          break
      }
    }

    calc(side)

    // Flip if overflowing
    if (top < 4 && side === 'top') {
      resolvedSide = 'bottom'
      calc('bottom')
    } else if (top + tooltipRect.height > window.innerHeight - 4 && side === 'bottom') {
      resolvedSide = 'top'
      calc('top')
    } else if (left < 4 && side === 'left') {
      resolvedSide = 'right'
      calc('right')
    } else if (left + tooltipRect.width > window.innerWidth - 4 && side === 'right') {
      resolvedSide = 'left'
      calc('left')
    }

    // Clamp to viewport
    left = Math.max(4, Math.min(left, window.innerWidth - tooltipRect.width - 4))
    top = Math.max(4, Math.min(top, window.innerHeight - tooltipRect.height - 4))

    setActualSide(resolvedSide)
    setPosition({ top, left })
  }, [side])

  const show = () => {
    timerRef.current = setTimeout(() => {
      setVisible(true)
    }, delay)
  }

  const hide = () => {
    clearTimeout(timerRef.current)
    setVisible(false)
  }

  useEffect(() => {
    if (visible) updatePosition()
  }, [visible, updatePosition])

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  return (
    <div
      ref={triggerRef}
      className={clsx('inline-flex', triggerClassName)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible && (
        <div
          ref={tooltipRef}
          role="tooltip"
          style={{ position: 'fixed', top: position.top, left: position.left }}
          className={clsx(
            'z-tooltip max-w-[280px] px-2.5 py-1.5 rounded-lg',
            'text-[11px] leading-[1.35] font-normal',
            'bg-bg-surface text-text-secondary',
            'border border-border-subtle shadow-sm',
            'pointer-events-none',
            'animate-in fade-in duration-100'
          )}
        >
          {content}
          <span
            className={clsx(
              'absolute w-1.5 h-1.5 rotate-45',
              'bg-bg-surface border-border-subtle',
              actualSide === 'top' && 'bottom-[-4px] left-1/2 -translate-x-1/2 border-b border-r',
              actualSide === 'bottom' && 'top-[-4px] left-1/2 -translate-x-1/2 border-t border-l',
              actualSide === 'left' && 'right-[-4px] top-1/2 -translate-y-1/2 border-t border-r',
              actualSide === 'right' && 'left-[-4px] top-1/2 -translate-y-1/2 border-b border-l'
            )}
          />
        </div>
      )}
    </div>
  )
}
