'use client'

import clsx from 'clsx'

export interface SkeletonProps {
  width?: string | number
  height?: string | number
  rounded?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  className?: string
}

export function Skeleton({
  width,
  height,
  rounded = 'lg',
  className,
}: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-shimmer bg-[length:200%_100%]',
        'bg-gradient-to-r from-bg-elevated via-border-subtle to-bg-elevated',
        rounded === 'sm' && 'rounded-sm',
        rounded === 'md' && 'rounded-md',
        rounded === 'lg' && 'rounded-lg',
        rounded === 'xl' && 'rounded-xl',
        rounded === 'full' && 'rounded-full',
        className
      )}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
      }}
    />
  )
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={clsx('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={14}
          className={i === lines - 1 ? 'w-3/4' : 'w-full'}
        />
      ))}
    </div>
  )
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={clsx('space-y-3 p-4', className)}>
      <Skeleton height={16} className="w-1/3" />
      <Skeleton height={32} className="w-2/3" />
      <Skeleton height={12} className="w-1/2" />
    </div>
  )
}
