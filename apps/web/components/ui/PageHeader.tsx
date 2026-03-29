import type { ReactNode } from 'react'
import { Card, CardContent } from './Card'

interface PageHeaderProps {
  /**
   * 小标签文本（可选）
   */
  eyebrow?: string
  /**
   * 页面标题（支持字符串或 ReactNode）
   */
  title: string | ReactNode
  /**
   * 副标题/描述
   */
  subtitle?: string
  /**
   * 右侧操作按钮区域
   */
  actions?: ReactNode
  /**
   * 自定义类名
   */
  className?: string
}

/**
 * 统一的页面头部组件
 * 采用大卡风格，包含标题、副标题和操作按钮区域
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  className = '',
}: PageHeaderProps) {
  return (
    <Card className={`border-border-default ${className}`}>
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            {eyebrow && (
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-text-tertiary">
                {eyebrow}
              </p>
            )}
            <h1 className="text-2xl font-semibold text-text-primary">
              {title}
            </h1>
            {subtitle && (
              <p className="text-sm text-text-secondary">
                {subtitle}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
