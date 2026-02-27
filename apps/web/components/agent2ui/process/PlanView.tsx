'use client'

import clsx from 'clsx'
import { Check, Circle, Loader2, XCircle } from 'lucide-react'
import type { PlanData, PlanStep } from '@/types'
import { useLocale } from '@/components/providers/LocaleProvider'

/**
 * PlanView - 计划步骤视图组件
 *
 * 根据 DESIGN_SYSTEM.md 中 PlanStepper 设计
 * 支持水平和垂直两种展示模式
 */

export interface PlanViewProps {
  data: PlanData
  className?: string
  mode?: 'horizontal' | 'vertical'
  variant?: 'card' | 'inline'
}

export function PlanView({ data, className, mode = 'horizontal', variant = 'card' }: PlanViewProps) {
  const { t } = useLocale()
  const getStepIcon = (step: PlanStep, small = false) => {
    const size = small ? 'w-6 h-6' : 'w-8 h-8'
    const iconSize = small ? 'w-3 h-3' : 'w-4 h-4'
    const smallCircle = small ? 'w-2 h-2' : 'w-3 h-3'

    switch (step.status) {
      case 'completed':
        return (
          <div className={clsx(size, 'rounded-full bg-success-500 flex items-center justify-center')}>
            <Check className={clsx(iconSize, 'text-neutral-950')} />
          </div>
        )
      case 'running':
        return (
          <div className={clsx(size, 'rounded-full bg-primary-500 flex items-center justify-center')}>
            <Loader2 className={clsx(iconSize, 'text-neutral-950 animate-spin')} />
          </div>
        )
      case 'failed':
        return (
          <div className={clsx(size, 'rounded-full bg-error-500 flex items-center justify-center')}>
            <XCircle className={clsx(iconSize, 'text-neutral-0')} />
          </div>
        )
      case 'skipped':
        return (
          <div className={clsx(size, 'rounded-full bg-neutral-600 flex items-center justify-center')}>
            <Circle className={clsx(smallCircle, 'text-neutral-400')} />
          </div>
        )
      case 'pending':
      default:
        return (
          <div className={clsx(size, 'rounded-full border-2 border-border-default flex items-center justify-center')}>
            <Circle className={clsx(smallCircle, 'text-text-tertiary')} />
          </div>
        )
    }
  }

  const getStatusLabel = (status: PlanStep['status']) => {
    const labels: Record<PlanStep['status'], string> = {
      pending: t('agent2ui.plan.status.pending'),
      running: t('agent2ui.plan.status.running'),
      completed: t('agent2ui.plan.status.completed'),
      failed: t('agent2ui.plan.status.failed'),
      skipped: t('agent2ui.plan.status.skipped'),
    }
    return labels[status]
  }

  if (variant === 'inline') {
    return (
      <div className={clsx('space-y-0', className)}>
        {data.steps.map((step: PlanStep, index: number) => (
          <div key={step.id} className="flex gap-3 items-start">
            <div className="flex flex-col items-center">
              {getStepIcon(step, true)}
              {index < data.steps.length - 1 && (
                <div
                  className={clsx(
                    'w-0.5 flex-1 min-h-[16px] my-0.5',
                    step.status === 'completed'
                      ? 'bg-success-500'
                      : 'bg-border-default'
                  )}
                />
              )}
            </div>
            <div className="flex-1 pb-3">
              <span
                className={clsx(
                  'text-sm',
                  step.status === 'running' && 'text-primary-500 font-medium',
                  step.status === 'completed' && 'text-text-primary',
                  step.status === 'failed' && 'text-error-500',
                  step.status === 'skipped' && 'text-neutral-400',
                  step.status === 'pending' && 'text-text-tertiary'
                )}
              >
                {step.title}
              </span>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (mode === 'horizontal') {
    return (
      <div className={clsx('overflow-x-auto', className)}>
        <div className="flex items-center gap-2 min-w-max p-4">
          {data.steps.map((step: PlanStep, index: number) => (
            <div key={step.id} className="flex items-center">
              {/* 步骤 */}
              <div className="flex flex-col items-center gap-2">
                {getStepIcon(step)}
                <span
                  className={clsx(
                    'text-xs font-medium whitespace-nowrap',
                    step.status === 'running' && 'text-primary-500',
                    step.status === 'completed' && 'text-success-500',
                    step.status === 'failed' && 'text-error-500',
                    step.status === 'skipped' && 'text-neutral-400',
                    step.status === 'pending' && 'text-text-tertiary'
                  )}
                >
                  {step.title}
                </span>
              </div>

              {/* 连接线 */}
              {index < data.steps.length - 1 && (
                <div
                  className={clsx(
                    'w-12 h-0.5 mx-2',
                    step.status === 'completed'
                      ? 'bg-success-500'
                      : 'bg-border-default'
                  )}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // 垂直模式
  return (
    <div className={clsx('space-y-0', className)}>
      {data.steps.map((step: PlanStep, index: number) => (
        <div key={step.id} className="flex gap-4">
          {/* 左侧：图标和连接线 */}
          <div className="flex flex-col items-center">
            {getStepIcon(step)}
            {index < data.steps.length - 1 && (
              <div
                className={clsx(
                  'w-0.5 flex-1 min-h-[24px] my-1',
                  step.status === 'completed'
                    ? 'bg-success-500'
                    : 'bg-border-default'
                )}
              />
            )}
          </div>

          {/* 右侧：内容 */}
          <div className="flex-1 pb-6">
            <div className="flex items-center justify-between">
              <h4
                className={clsx(
                  'font-medium',
                  step.status === 'running' && 'text-primary-500',
                  step.status === 'completed' && 'text-text-primary',
                  step.status === 'failed' && 'text-error-500',
                  step.status === 'skipped' && 'text-neutral-400',
                  step.status === 'pending' && 'text-text-secondary'
                )}
              >
                {step.title}
              </h4>
              <span
                className={clsx(
                  'text-xs px-2 py-0.5 rounded',
                  step.status === 'running' && 'bg-primary-500/10 text-primary-500',
                  step.status === 'completed' && 'bg-success-500/10 text-success-500',
                  step.status === 'failed' && 'bg-error-500/10 text-error-500',
                  step.status === 'skipped' && 'bg-neutral-700/50 text-neutral-400',
                  step.status === 'pending' && 'bg-neutral-700/50 text-text-tertiary'
                )}
              >
                {getStatusLabel(step.status)}
              </span>
            </div>

            {/* 子步骤 */}
            {step.substeps && step.substeps.length > 0 && (
              <div className="mt-2 ml-2 space-y-1">
                {step.substeps.map((substep: PlanStep) => (
                  <div
                    key={substep.id}
                    className="flex items-center gap-2 text-sm text-text-secondary"
                  >
                    {substep.status === 'completed' ? (
                      <Check className="w-3 h-3 text-success-500" />
                    ) : substep.status === 'running' ? (
                      <Loader2 className="w-3 h-3 text-primary-500 animate-spin" />
                    ) : (
                      <Circle className="w-3 h-3 text-text-tertiary" />
                    )}
                    <span>{substep.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

PlanView.displayName = 'PlanView'
