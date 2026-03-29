import type { RuntimeAttemptView } from '@/types'
import type { RuntimeAttemptDetailContent } from '@/stores/layoutStore'
import { tailId } from '@/lib/runtime-attempt-ui'

function formatTime(dateString: string | null | undefined, locale: string): string {
  if (!dateString) return '--'
  const date = new Date(dateString)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString(locale)
}

export function buildAttemptDetailContent(view: RuntimeAttemptView, locale: string): RuntimeAttemptDetailContent {
  return {
    kind: 'runtime-attempt',
    title: buildAttemptDetailTitle(view.attempt.id),
    attemptId: view.attempt.id,
    sessionId: view.session.id,
    userMessageId: view.attempt.userMessageId,
    status: view.attempt.status,
    executionMode: view.attempt.executionMode,
    latestRevision: view.attempt.latestRevision,
    resumeCount: view.attempt.resumeCount,
    approvalSetRevision: view.attempt.approvalSetRevision,
    terminalReason: view.attempt.terminalReason || undefined,
    latestCheckpoint: view.latestCheckpoint
      ? {
          checkpointId: view.latestCheckpoint.checkpointId,
          revision: view.latestCheckpoint.revision,
          status: view.latestCheckpoint.status,
          createdAt: formatTime(view.latestCheckpoint.createdAt, locale),
        }
      : null,
    pendingEventOutboxCount: view.eventOutbox.filter((item) => item.status !== 'delivered').length,
    pendingCheckpointOutboxCount: view.checkpointOutbox.filter((item) => item.status !== 'delivered').length,
    notices: view.notices.map((notice) => ({
      kind: notice.kind,
      message: notice.message,
    })),
  }
}

export function buildAttemptDetailTitle(attemptId: string): string {
  return `Attempt ${tailId(attemptId)}`
}
