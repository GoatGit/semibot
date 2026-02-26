'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Activity, RefreshCw, RotateCcw, AlertCircle, Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { useEvents } from '@/hooks/useEvents'
import type { EventRecord } from '@/types'

function formatTime(dateString: string): string {
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN')
}

function mapRiskVariant(risk?: EventRecord['riskHint']): 'default' | 'success' | 'warning' | 'error' {
  if (risk === 'high') return 'error'
  if (risk === 'medium') return 'warning'
  if (risk === 'low') return 'success'
  return 'default'
}

export default function EventsPage() {
  const [eventType, setEventType] = useState('')
  const [replayingId, setReplayingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null)

  const {
    events,
    isLoading,
    error,
    apiAvailable,
    loadEvents,
    replayEvent,
  } = useEvents()

  const eventTypeOptions = useMemo(() => {
    const set = new Set(events.map((item) => item.eventType))
    return Array.from(set).slice(0, 8)
  }, [events])

  const refresh = useCallback(async () => {
    await loadEvents({
      type: eventType.trim() || undefined,
      limit: 100,
    })
  }, [eventType, loadEvents])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleReplay = async (eventId: string) => {
    try {
      setActionError(null)
      setReplayingId(eventId)
      await replayEvent(eventId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '回放失败')
    } finally {
      setReplayingId(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-bg-base">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 space-y-6">
        <Card className="border-border-default">
          <CardContent className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                  <Activity size={22} className="text-primary-400" />
                  事件中心
                </h1>
                <p className="mt-2 text-sm text-text-secondary">
                  查看系统触发事件、匹配结果，并支持单事件回放。
                </p>
              </div>
              <Button
                variant="secondary"
                leftIcon={<RefreshCw size={16} />}
                onClick={() => void refresh()}
                disabled={isLoading}
              >
                刷新
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border-default">
          <CardContent className="p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex-1">
                <Input
                  value={eventType}
                  onChange={(e) => setEventType(e.target.value)}
                  placeholder="按事件类型过滤（例如 task.completed）"
                />
              </div>
              <Button
                variant="secondary"
                leftIcon={<Search size={14} />}
                onClick={() => void refresh()}
                disabled={isLoading}
              >
                查询
              </Button>
            </div>
            {eventTypeOptions.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {eventTypeOptions.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className={clsx(
                      'rounded-full border px-3 py-1 text-xs',
                      item === eventType
                        ? 'border-primary-500 text-primary-300'
                        : 'border-border-default text-text-secondary hover:border-border-strong'
                    )}
                    onClick={() => setEventType((prev) => (prev === item ? '' : item))}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {!apiAvailable && (
          <div className="rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-warning-500">
            事件 API 尚未接入，请先实现 `/v1/events` 与 `/v1/events/replay`。
          </div>
        )}

        {(error || actionError) && (
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3 text-sm text-error-500 flex items-center gap-2">
            <AlertCircle size={16} />
            {actionError || error}
          </div>
        )}

        <div className="space-y-3">
          {isLoading && events.length === 0 ? (
            [1, 2, 3].map((index) => (
              <Card key={index} className="border-border-subtle">
                <CardContent className="p-4 animate-pulse">
                  <div className="h-4 w-40 rounded bg-bg-elevated mb-3" />
                  <div className="h-3 w-full rounded bg-bg-elevated mb-2" />
                  <div className="h-3 w-3/4 rounded bg-bg-elevated" />
                </CardContent>
              </Card>
            ))
          ) : events.length > 0 ? (
            events.map((event) => (
              <Card key={event.id} className="border-border-subtle">
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-text-primary break-all">{event.eventType}</p>
                        <Badge variant={mapRiskVariant(event.riskHint)}>
                          风险 {event.riskHint || 'unknown'}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-text-secondary">
                        {event.id} · {event.source} · {formatTime(event.createdAt)}
                      </div>
                      {event.subject && (
                        <div className="mt-2 text-sm text-text-secondary break-all">
                          subject: {event.subject}
                        </div>
                      )}
                      {event.payload && (
                        <pre className="mt-2 rounded-md bg-bg-elevated border border-border-subtle px-3 py-2 text-xs text-text-secondary overflow-x-auto">
                          {JSON.stringify(event.payload, null, 2).slice(0, 240)}
                          {JSON.stringify(event.payload).length > 240 ? ' ...' : ''}
                        </pre>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSelectedEvent(event)}
                      >
                        详情
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<RotateCcw size={14} />}
                        loading={replayingId === event.id}
                        onClick={() => void handleReplay(event.id)}
                      >
                        回放
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <Card className="border-border-subtle">
              <CardContent className="p-8 text-center text-sm text-text-secondary">
                暂无事件数据
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={selectedEvent !== null}
        onClose={() => setSelectedEvent(null)}
        title="事件详情"
        description={selectedEvent ? `${selectedEvent.eventType} · ${selectedEvent.id}` : undefined}
        maxWidth="lg"
      >
        {selectedEvent && (
          <div className="space-y-3">
            <div className="text-xs text-text-secondary">
              <div>source: {selectedEvent.source}</div>
              <div>time: {formatTime(selectedEvent.createdAt)}</div>
              {selectedEvent.subject && <div>subject: {selectedEvent.subject}</div>}
            </div>
            <pre className="rounded-md bg-bg-elevated border border-border-subtle px-3 py-2 text-xs text-text-secondary overflow-x-auto max-h-[50vh]">
              {JSON.stringify(selectedEvent.payload ?? {}, null, 2)}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  )
}
