'use client'

import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: (SelectOption | SelectGroup)[]
  placeholder?: string
  disabled?: boolean
  error?: boolean
  errorMessage?: string
  size?: 'sm' | 'md' | 'lg'
  id?: string
  'data-testid'?: string
  className?: string
}

function isGroup(item: SelectOption | SelectGroup): item is SelectGroup {
  return 'options' in item
}

function flatOptions(items: (SelectOption | SelectGroup)[]): SelectOption[] {
  const result: SelectOption[] = []
  for (const item of items) {
    if (isGroup(item)) {
      result.push(...item.options)
    } else {
      result.push(item)
    }
  }
  return result
}

export function Select({
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error = false,
  errorMessage,
  size = 'md',
  id,
  'data-testid': testId,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const flat = flatOptions(options)
  const selectedOption = flat.find((o) => o.value === value)

  const close = useCallback(() => {
    setOpen(false)
    setFocusIndex(-1)
  }, [])

  // Click outside to close
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, close])

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex < 0 || !listRef.current) return
    const items = listRef.current.querySelectorAll('[data-option-index]')
    items[focusIndex]?.scrollIntoView({ block: 'nearest' })
  }, [focusIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return

    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (!open) {
          setOpen(true)
          const idx = flat.findIndex((o) => o.value === value)
          setFocusIndex(idx >= 0 ? idx : 0)
        } else if (focusIndex >= 0 && !flat[focusIndex]?.disabled) {
          onChange(flat[focusIndex].value)
          close()
        }
        break
      case 'ArrowDown':
        e.preventDefault()
        if (!open) {
          setOpen(true)
          const idx = flat.findIndex((o) => o.value === value)
          setFocusIndex(idx >= 0 ? idx : 0)
        } else {
          setFocusIndex((prev) => {
            let next = prev + 1
            while (next < flat.length && flat[next].disabled) next++
            return next < flat.length ? next : prev
          })
        }
        break
      case 'ArrowUp':
        e.preventDefault()
        if (open) {
          setFocusIndex((prev) => {
            let next = prev - 1
            while (next >= 0 && flat[next].disabled) next--
            return next >= 0 ? next : prev
          })
        }
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
    }
  }

  const handleSelect = (opt: SelectOption) => {
    if (opt.disabled) return
    onChange(opt.value)
    close()
  }

  let optionIndex = 0

  return (
    <div ref={containerRef} className={clsx('relative w-full', className)}>
      <button
        type="button"
        id={id}
        data-testid={testId}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setOpen((prev) => !prev)
            if (!open) {
              const idx = flat.findIndex((o) => o.value === value)
              setFocusIndex(idx >= 0 ? idx : 0)
            }
          }
        }}
        onKeyDown={handleKeyDown}
        className={clsx(
          'w-full rounded-md text-left flex items-center justify-between gap-2',
          'bg-bg-surface border',
          'transition-all duration-fast ease-out',
          'focus:outline-none',

          size === 'sm' && 'h-8 px-3 text-sm',
          size === 'md' && 'h-10 px-3 text-base',
          size === 'lg' && 'h-12 px-4 text-lg',

          !error && [
            'border-border-default',
            'hover:border-border-strong',
            'focus:border-primary-500 focus:shadow-glow-primary',
          ],
          error && ['border-error-500', 'focus:border-error-500 focus:shadow-glow-error'],
          disabled && ['bg-bg-base text-text-disabled cursor-not-allowed', 'border-border-subtle'],

          selectedOption ? 'text-text-primary' : 'text-text-tertiary'
        )}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span className="truncate">{selectedOption?.label ?? placeholder}</span>
        <ChevronDown
          className={clsx(
            'w-4 h-4 shrink-0 text-text-tertiary transition-transform duration-fast',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className={clsx(
            'absolute z-50 mt-1 w-full',
            'bg-bg-surface border border-border-default rounded-md shadow-lg',
            'max-h-60 overflow-auto',
            'py-1'
          )}
        >
          {options.map((item) => {
            if (isGroup(item)) {
              return (
                <div key={item.label}>
                  <div className="px-3 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
                    {item.label}
                  </div>
                  {item.options.map((opt) => {
                    const idx = optionIndex++
                    return (
                      <div
                        key={opt.value}
                        data-option-index={idx}
                        role="option"
                        aria-selected={opt.value === value}
                        onClick={() => handleSelect(opt)}
                        className={clsx(
                          'px-3 py-2 text-sm cursor-pointer',
                          'transition-colors duration-fast',
                          opt.value === value && 'text-primary-500 bg-primary-500/10',
                          opt.value !== value && 'text-text-primary',
                          focusIndex === idx && 'bg-bg-subtle',
                          opt.disabled && 'text-text-disabled cursor-not-allowed opacity-50'
                        )}
                      >
                        {opt.label}
                      </div>
                    )
                  })}
                </div>
              )
            }

            const idx = optionIndex++
            return (
              <div
                key={item.value}
                data-option-index={idx}
                role="option"
                aria-selected={item.value === value}
                onClick={() => handleSelect(item)}
                className={clsx(
                  'px-3 py-2 text-sm cursor-pointer',
                  'transition-colors duration-fast',
                  item.value === value && 'text-primary-500 bg-primary-500/10',
                  item.value !== value && 'text-text-primary',
                  focusIndex === idx && 'bg-bg-subtle',
                  item.disabled && 'text-text-disabled cursor-not-allowed opacity-50'
                )}
              >
                {item.label}
              </div>
            )
          })}
        </div>
      )}

      {error && errorMessage && (
        <p className="mt-1.5 text-sm text-error-500">{errorMessage}</p>
      )}
    </div>
  )
}
