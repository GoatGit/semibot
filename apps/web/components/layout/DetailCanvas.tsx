'use client'

import { useEffect, useRef, useState } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { DETAIL_CANVAS_WIDTH_PX, PATHS_WITHOUT_DETAIL } from '@/constants/config'
import clsx from 'clsx'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  FileText,
  Waves,
  AlertTriangle,
  Cpu,
  Clock3,
  Copy,
  Check,
  FileSearch,
  ChevronLeftCircle,
  ChevronRightCircle,
} from 'lucide-react'
import { useLocale } from '@/components/providers/LocaleProvider'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'
import { apiClient } from '@/lib/api'
import { copyToClipboard } from '@/lib/utils'

/**
 * DetailCanvas - 详情画布
 *
 * 根据 ARCHITECTURE.md 设计:
 * - 折叠状态: 隐藏
 * - 展开状态: 320px
 * - 最大化状态: 100%
 * - 职责: 结果数据、报告展示
 */
export function DetailCanvas() {
  const { t } = useLocale()
  const {
    detailCanvasMode,
    detailContent,
    currentPath,
    collapseDetail,
    expandDetail,
    maximizeDetail,
    exitMaximize
  } = useLayoutStore()

  const isPathWithoutDetail = PATHS_WITHOUT_DETAIL.some(
    (p) => currentPath === p || currentPath.startsWith(`${p}/`)
  )

  // 折叠状态下，若当前路径不需要详情画布，完全不渲染
  if (detailCanvasMode === 'collapsed' && isPathWithoutDetail) {
    return null
  }

  // 折叠状态时只显示展开按钮
  if (detailCanvasMode === 'collapsed') {
    return (
      <div className="absolute right-0 top-0 bottom-0 z-20 flex items-center">
        <button
          onClick={expandDetail}
          className={clsx(
            'flex h-full w-8 items-center justify-center border-l border-border-subtle bg-bg-surface/95 backdrop-blur-sm',
            'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
            'transition-colors duration-fast'
          )}
          aria-label={t('detailCanvas.expand')}
        >
          <ChevronLeft size={18} />
        </button>
      </div>
    )
  }

  // 最大化状态
  if (detailCanvasMode === 'maximized') {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-bg-surface">
        <DetailHeader
          onMinimize={exitMaximize}
          title={detailContent?.title || t('detailCanvas.title')}
          collapseLabel={t('detailCanvas.collapse')}
          maximizeLabel={t('detailCanvas.maximize')}
          exitMaximizeLabel={t('detailCanvas.exitMaximize')}
        />
        <DetailContent />
      </div>
    )
  }

  // 正常展开状态
  return (
    <>
      <button
        type="button"
        className="absolute inset-0 z-10 cursor-default bg-transparent"
        aria-label={t('detailCanvas.collapse')}
        onClick={collapseDetail}
      />
      <div
        style={{ width: DETAIL_CANVAS_WIDTH_PX }}
        className={clsx(
          'absolute right-0 top-0 bottom-0 z-20 flex flex-col overflow-hidden',
          'bg-bg-surface/98 border-l border-border-subtle shadow-2xl backdrop-blur-sm',
          'transition-all duration-normal ease-out'
        )}
      >
        <DetailHeader
          onCollapse={collapseDetail}
          onMaximize={maximizeDetail}
          title={detailContent?.title || t('detailCanvas.title')}
          collapseLabel={t('detailCanvas.collapse')}
          maximizeLabel={t('detailCanvas.maximize')}
          exitMaximizeLabel={t('detailCanvas.exitMaximize')}
        />
        <DetailContent />
      </div>
    </>
  )
}

interface DetailHeaderProps {
  onCollapse?: () => void
  onMaximize?: () => void
  onMinimize?: () => void
  title: string
  collapseLabel: string
  maximizeLabel: string
  exitMaximizeLabel?: string
}

function DetailHeader({ onCollapse, onMaximize, onMinimize, title, collapseLabel, maximizeLabel, exitMaximizeLabel }: DetailHeaderProps) {
  return (
    <div
      className={clsx(
        'flex items-center justify-between px-4 h-14',
        'border-b border-border-subtle'
      )}
    >
      <div>
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <div className="flex items-center gap-1">
        {onCollapse && (
          <button
            onClick={onCollapse}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label={collapseLabel}
          >
            <ChevronRight size={16} />
          </button>
        )}
        {onMaximize && (
          <button
            onClick={onMaximize}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label={maximizeLabel}
          >
            <Maximize2 size={16} />
          </button>
        )}
        {onMinimize && (
          <button
            onClick={onMinimize}
            className={clsx(
              'p-2 rounded-md',
              'text-text-secondary hover:text-text-primary hover:bg-interactive-hover',
              'transition-colors duration-fast'
            )}
            aria-label={exitMaximizeLabel}
          >
            <Minimize2 size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

interface DetailChunk {
  chunkId: string
  content: string
}

function parseChunkNumber(chunkId: string): number | null {
  const match = String(chunkId).trim().toLowerCase().match(/^c(\d{3,})$/)
  if (!match) return null
  return Number(match[1])
}

function formatChunkId(value: number): string {
  return `c${String(value).padStart(4, '0')}`
}

function DetailContent() {
  const { t } = useLocale()
  const { detailContent } = useLayoutStore()
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(null)
  const [selectedRuntimeIncidentId, setSelectedRuntimeIncidentId] = useState<string | null>(null)
  const runtimeIncidentRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [loadedChunks, setLoadedChunks] = useState<DetailChunk[]>([])
  const [isChunkLoading, setIsChunkLoading] = useState(false)
  const [chunkError, setChunkError] = useState<string | null>(null)

  useEffect(() => {
    if (detailContent?.kind === 'document-chunk') {
      setSelectedChunkId(detailContent.selectedChunkId)
      setLoadedChunks(detailContent.chunks)
      setChunkError(null)
      return
    }
    setSelectedChunkId(null)
    setLoadedChunks([])
    setChunkError(null)
  }, [detailContent])

  useEffect(() => {
    if (detailContent?.kind === 'runtime-session') {
      setSelectedRuntimeIncidentId(detailContent.initialFocusedIncidentId || null)
      return
    }
    setSelectedRuntimeIncidentId(null)
  }, [detailContent])

  useEffect(() => {
    if (!selectedRuntimeIncidentId) return
    const target = runtimeIncidentRefs.current[selectedRuntimeIncidentId]
    if (!target) return
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedRuntimeIncidentId])

  if (detailContent?.kind === 'markdown') {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {detailContent.filename && (
          <div className="mb-4 text-xs uppercase tracking-[0.08em] text-text-tertiary">
            {detailContent.filename}
          </div>
        )}
        <MarkdownBlock
          data={{ content: detailContent.content }}
          variant="report"
          className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5"
        />
      </div>
    )
  }

  if (detailContent?.kind === 'runtime-session') {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-4">
          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded-md border border-border-default bg-bg-base px-2 py-1 text-xs font-medium text-text-primary">
                {detailContent.statusLabel}
              </div>
              <div className="rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-xs text-text-secondary">
                {detailContent.sessionId}
              </div>
              {detailContent.attemptId ? (
                <div className="rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-xs text-text-secondary">
                  Attempt {detailContent.attemptId}
                </div>
              ) : null}
            </div>
            <div className="mt-4 text-base font-semibold text-text-primary">{detailContent.summary}</div>
            <div className="mt-2 text-sm text-text-secondary">{detailContent.actionLabel}</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <DetailMetricCard icon={<Clock3 size={14} />} label={t('runtimeMonitor.labels.lastHeartbeatAt')} value={detailContent.lastSeenAt} />
              <DetailMetricCard icon={<Clock3 size={14} />} label={t('runtimeMonitor.labels.idleFor')} value={detailContent.idleFor} />
              <DetailMetricCard icon={<AlertTriangle size={14} />} label={t('runtimeMonitor.labels.failures')} value={String(detailContent.failures)} />
              <DetailMetricCard icon={<Waves size={14} />} label={t('runtimeMonitor.groups.loopAlerts')} value={String(detailContent.loopAlerts)} />
              <DetailMetricCard icon={<Cpu size={14} />} label={t('runtimeMonitor.groups.drUpgrades')} value={String(detailContent.drUpgrades)} />
              <DetailMetricCard icon={<Cpu size={14} />} label={t('runtimeMonitor.labels.tokens')} value={detailContent.totalTokens} />
              <DetailMetricCard icon={<Cpu size={14} />} label={t('runtimeMonitor.labels.toolName')} value={detailContent.toolName || '--'} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Latest revision" value={detailContent.latestRevision ? String(detailContent.latestRevision) : '--'} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Checkpoint" value={detailContent.latestCheckpointRevision ? `r${detailContent.latestCheckpointRevision} · ${detailContent.latestCheckpointStatus || '--'}` : '--'} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Event outbox" value={String(detailContent.pendingEventOutboxCount ?? 0)} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Checkpoint outbox" value={String(detailContent.pendingCheckpointOutboxCount ?? 0)} />
              <DetailMetricCard icon={<AlertTriangle size={14} />} label="Terminal reason" value={detailContent.terminalReason || '--'} />
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="text-sm font-semibold text-text-primary">{t('runtimeMonitor.sessionDrawer.pathTitle')}</div>
            <div className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sessionDrawer.pathHint')}</div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-border-subtle bg-bg-base px-4 py-4">
                <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{t('runtimeMonitor.labels.routeDecision')}</div>
                <div className="mt-2 text-sm font-medium text-text-primary">{detailContent.routeMode || '--'}</div>
                <div className="mt-1 text-xs text-text-tertiary">{detailContent.routeAt || '--'}</div>
                <div className="mt-3 text-sm leading-relaxed text-text-secondary">{detailContent.routeReason || '--'}</div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-base px-4 py-4">
                <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{t('runtimeMonitor.labels.directReasoning')}</div>
                <div className="mt-2 text-sm font-medium text-text-primary">{detailContent.drStatus || '--'}</div>
                <div className="mt-1 text-xs text-text-tertiary">{detailContent.drAt || '--'}</div>
                <div className="mt-3 text-sm leading-relaxed text-text-secondary">{detailContent.drReason || '--'}</div>
              </div>
              <div className="rounded-lg border border-border-subtle bg-bg-base px-4 py-4">
                <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{t('runtimeMonitor.labels.drUpgrade')}</div>
                <div className="mt-2 text-sm font-medium text-text-primary">{detailContent.upgradeAt || '--'}</div>
                <div className="mt-3 text-sm leading-relaxed text-text-secondary">{detailContent.upgradeReason || '--'}</div>
              </div>
            </div>

            {detailContent.pathTransitions.length > 0 ? (
              <div className="mt-4 space-y-3">
                {detailContent.pathTransitions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedRuntimeIncidentId(item.id)}
                    className={clsx(
                      'block w-full rounded-lg border px-4 py-4 text-left transition-colors',
                      item.variant === 'warning'
                        ? 'border-warning-500/30 bg-warning-500/6'
                        : item.variant === 'error'
                          ? 'border-error-500/30 bg-error-500/5'
                          : item.variant === 'success'
                            ? 'border-success-500/25 bg-success-500/5'
                            : 'border-border-subtle bg-bg-base',
                      selectedRuntimeIncidentId === item.id ? 'ring-1 ring-primary-400/60' : 'hover:border-border-default'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary">{item.title}</div>
                        <div className="mt-1 text-sm text-text-secondary">{item.detail}</div>
                      </div>
                      <div className="text-xs text-text-tertiary">{item.createdAt}</div>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="text-sm font-semibold text-text-primary">{t('runtimeMonitor.sessionDrawer.incidentsTitle')}</div>
            <div className="mt-1 text-sm text-text-secondary">{t('runtimeMonitor.sessionDrawer.incidentsHint')}</div>
            {detailContent.incidents.length === 0 ? (
              <div className="mt-4 rounded-lg border border-border-subtle bg-bg-base px-4 py-4 text-sm text-text-secondary">
                {t('runtimeMonitor.sessionDrawer.noIncidents')}
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                {detailContent.incidents.map((incident) => (
                  <div
                    key={incident.id}
                    ref={(node) => {
                      runtimeIncidentRefs.current[incident.id] = node
                    }}
                    className={clsx(
                      'rounded-lg border bg-bg-base px-4 py-4 transition-colors',
                      selectedRuntimeIncidentId === incident.id
                        ? 'border-primary-400/60 bg-primary-500/5'
                        : 'border-border-subtle'
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text-primary">{incident.title}</div>
                        <div className="mt-1 text-xs text-text-tertiary">{incident.type}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {incident.raw ? (
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await copyToClipboard(JSON.stringify(incident.raw, null, 2))
                              if (!ok) return
                              setCopiedId(incident.id)
                              window.setTimeout(() => {
                                setCopiedId((current) => (current === incident.id ? null : current))
                              }, 1500)
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border-subtle bg-bg-elevated text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
                            title={copiedId === incident.id ? t('common.copied') : t('runtimeMonitor.copyEvent')}
                            aria-label={copiedId === incident.id ? t('common.copied') : t('runtimeMonitor.copyEvent')}
                          >
                            {copiedId === incident.id ? <Check size={14} /> : <Copy size={14} />}
                          </button>
                        ) : null}
                        <div className="text-xs text-text-tertiary">{incident.createdAt}</div>
                      </div>
                    </div>
                    <div className="mt-2 text-sm leading-relaxed text-text-secondary">{incident.detail}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (detailContent?.kind === 'runtime-attempt') {
    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-4">
          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="rounded-md border border-border-default bg-bg-base px-2 py-1 text-xs font-medium text-text-primary">
                {detailContent.status}
              </div>
              <div className="rounded-md border border-border-subtle bg-bg-base px-2 py-1 text-xs text-text-secondary">
                {detailContent.attemptId}
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <DetailMetricCard icon={<Cpu size={14} />} label="Session" value={detailContent.sessionId} />
              <DetailMetricCard icon={<Cpu size={14} />} label="User Message" value={detailContent.userMessageId} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Execution Mode" value={detailContent.executionMode} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Latest Revision" value={String(detailContent.latestRevision)} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Resume Count" value={String(detailContent.resumeCount)} />
              <DetailMetricCard icon={<Cpu size={14} />} label="Approval Set Revision" value={String(detailContent.approvalSetRevision)} />
              <DetailMetricCard icon={<AlertTriangle size={14} />} label="Terminal Reason" value={detailContent.terminalReason || '--'} />
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="text-sm font-semibold text-text-primary">Latest Checkpoint</div>
            {detailContent.latestCheckpoint ? (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <DetailMetricCard icon={<FileSearch size={14} />} label="Checkpoint" value={detailContent.latestCheckpoint.checkpointId} />
                <DetailMetricCard icon={<FileSearch size={14} />} label="Revision" value={String(detailContent.latestCheckpoint.revision)} />
                <DetailMetricCard icon={<FileSearch size={14} />} label="Status" value={detailContent.latestCheckpoint.status} />
                <DetailMetricCard icon={<Clock3 size={14} />} label="Created At" value={detailContent.latestCheckpoint.createdAt} />
              </div>
            ) : (
              <div className="mt-3 text-sm text-text-secondary">None</div>
            )}
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="text-sm font-semibold text-text-primary">Outbox</div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <DetailMetricCard icon={<Waves size={14} />} label="Event Outbox Pending" value={String(detailContent.pendingEventOutboxCount)} />
              <DetailMetricCard icon={<Waves size={14} />} label="Checkpoint Outbox Pending" value={String(detailContent.pendingCheckpointOutboxCount)} />
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="text-sm font-semibold text-text-primary">Notices</div>
            {detailContent.notices.length === 0 ? (
              <div className="mt-3 text-sm text-text-secondary">None</div>
            ) : (
              <div className="mt-4 space-y-3">
                {detailContent.notices.map((notice, index) => (
                  <div key={`${notice.kind}-${index}`} className="rounded-lg border border-border-subtle bg-bg-base px-4 py-4">
                    <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">{notice.kind}</div>
                    <div className="mt-2 text-sm text-text-secondary">{notice.message}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (detailContent?.kind === 'document-chunk') {
    const activeChunkId = selectedChunkId || detailContent.selectedChunkId
    const sortedChunks = [...loadedChunks].sort((a, b) => {
      const left = parseChunkNumber(a.chunkId) ?? 0
      const right = parseChunkNumber(b.chunkId) ?? 0
      return left - right
    })
    const chunkIndex = sortedChunks.findIndex((item) => item.chunkId === activeChunkId)
    const safeIndex = chunkIndex >= 0 ? chunkIndex : 0
    const activeChunk = sortedChunks[safeIndex]
    const previousChunk = safeIndex > 0 ? sortedChunks[safeIndex - 1] : null
    const nextChunk = safeIndex < sortedChunks.length - 1 ? sortedChunks[safeIndex + 1] : null
    const firstLoadedChunkId = sortedChunks[0]?.chunkId || '--'
    const lastLoadedChunkId = sortedChunks[sortedChunks.length - 1]?.chunkId || '--'
    const loadedRange = firstLoadedChunkId === lastLoadedChunkId
      ? firstLoadedChunkId
      : `${firstLoadedChunkId} - ${lastLoadedChunkId}`
    const activeChunkNumber = parseChunkNumber(activeChunk?.chunkId || '')
    const canLoadPrevious = !!activeChunkNumber && activeChunkNumber > 1
    const canLoadNext = !!activeChunkNumber && activeChunkNumber < detailContent.totalChunks

    const loadChunk = async (chunkId: string): Promise<DetailChunk | null> => {
      try {
        setIsChunkLoading(true)
        setChunkError(null)
        const response = await apiClient.get<{
          success?: boolean
          data?: DetailChunk
        }>(`/sessions/${detailContent.sessionId}/document-chunk`, {
          params: {
            docId: detailContent.docId,
            version: detailContent.version,
            chunkId,
          },
        })
        if (!response?.data?.chunkId) {
          setChunkError('文档片段未找到。')
          return null
        }
        return response.data
      } catch (error) {
        setChunkError(error instanceof Error ? error.message : '文档片段加载失败。')
        return null
      } finally {
        setIsChunkLoading(false)
      }
    }

    const handleSelectRelativeChunk = async (direction: 'previous' | 'next') => {
      const fallbackChunk = direction === 'previous' ? previousChunk : nextChunk
      if (fallbackChunk) {
        setSelectedChunkId(fallbackChunk.chunkId)
        return
      }
      if (!activeChunkNumber) return
      const targetNumber = direction === 'previous' ? activeChunkNumber - 1 : activeChunkNumber + 1
      if (targetNumber < 1 || targetNumber > detailContent.totalChunks) return
      const targetChunkId = formatChunkId(targetNumber)
      const fetched = await loadChunk(targetChunkId)
      if (!fetched) return
      setLoadedChunks((current) => {
        if (current.some((item) => item.chunkId === fetched.chunkId)) return current
        return [...current, fetched]
      })
      setSelectedChunkId(targetChunkId)
    }

    return (
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="space-y-4">
          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-[0.08em] text-text-tertiary">Evidence</div>
                <div className="mt-1 text-base font-semibold text-text-primary">{detailContent.docTitle}</div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  if (!activeChunk?.content) return
                  const ok = await copyToClipboard(activeChunk.content)
                  if (!ok) return
                  setCopiedId(activeChunk.chunkId)
                  window.setTimeout(() => {
                    setCopiedId((current) => (current === activeChunk.chunkId ? null : current))
                  }, 1500)
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary"
              >
                {copiedId === activeChunk?.chunkId ? <Check size={14} /> : <Copy size={14} />}
                {copiedId === activeChunk?.chunkId ? t('common.copied') : '复制原文'}
              </button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <DetailMetricCard icon={<FileSearch size={14} />} label="文档 ID" value={detailContent.docId} />
              <DetailMetricCard icon={<FileSearch size={14} />} label="版本" value={`v${detailContent.version}`} />
              <DetailMetricCard icon={<FileSearch size={14} />} label="当前片段" value={activeChunk?.chunkId || '--'} />
              <DetailMetricCard icon={<FileSearch size={14} />} label="已加载范围" value={loadedRange} />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {sortedChunks.map((chunk) => (
                <button
                  key={chunk.chunkId}
                  type="button"
                  onClick={() => setSelectedChunkId(chunk.chunkId)}
                  className={clsx(
                    'rounded-md border px-2.5 py-1 text-xs transition-colors',
                    chunk.chunkId === activeChunk?.chunkId
                      ? 'border-primary-500/40 bg-primary-500/10 text-primary-300'
                      : 'border-border-subtle text-text-secondary hover:bg-interactive-hover hover:text-text-primary'
                  )}
                >
                  {chunk.chunkId}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg-elevated px-5 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-text-primary">原文证据</div>
                <div className="mt-1 text-sm text-text-secondary">
                  当前展示 {activeChunk?.chunkId || '--'}，总片段数 {detailContent.totalChunks}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleSelectRelativeChunk('previous')}
                  disabled={isChunkLoading || (!previousChunk && !canLoadPrevious)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeftCircle size={14} />
                  上一段
                </button>
                <button
                  type="button"
                  onClick={() => void handleSelectRelativeChunk('next')}
                  disabled={isChunkLoading || (!nextChunk && !canLoadNext)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-interactive-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  下一段
                  <ChevronRightCircle size={14} />
                </button>
              </div>
            </div>

            {chunkError && (
              <div className="mt-4 rounded-lg border border-error-400/30 bg-error-500/5 px-4 py-3 text-sm text-error-300">
                {chunkError}
              </div>
            )}
            <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-xl border border-border-subtle bg-bg-base px-4 py-4 text-sm leading-7 text-text-primary">
              {activeChunk?.content || '无可展示的文档片段。'}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4">
      <FileText size={48} className="text-text-tertiary mb-4" />
      <p className="text-sm text-text-secondary">{t('detailCanvas.emptyTitle')}</p>
      <p className="text-xs text-text-tertiary mt-1">{t('detailCanvas.emptyDescription')}</p>
    </div>
  )
}

function DetailMetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-base px-3 py-3">
      <div className="flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-text-tertiary">
        <span>{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-sm font-medium text-text-primary">{value}</div>
    </div>
  )
}
