import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChat } from '@/hooks/useChat'

function createStreamingResponse(chunks: string[]) {
  let index = 0
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) {
              return { done: true, value: undefined }
            }
            const encoder = new TextEncoder()
            const value = encoder.encode(chunks[index])
            index += 1
            return { done: false, value }
          },
        }
      },
    },
  }
}

describe('useChat refresh recovery', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('does not emit Load failed on unmount abort and can resume active session stream', async () => {
    const onMessage = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()

    const fetchMock = vi.mocked(global.fetch)
    fetchMock.mockImplementationOnce((_, init) => {
      return new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Load failed', 'AbortError'))
        })
      }) as ReturnType<typeof fetch>
    })

    const { result, unmount } = renderHook(() =>
      useChat({
        sessionId: 'sess-1',
        onMessage,
        onComplete,
        onError,
      })
    )

    await act(async () => {
      void result.current.sendMessage('hello')
    })

    unmount()

    await waitFor(() => {
      expect(onError).not.toHaveBeenCalled()
    })

    window.sessionStorage.setItem('semibot:last-event-id:sess-1', 'evt-1')

    fetchMock.mockImplementationOnce(async (_, init) => {
      const headers = new Headers(init?.headers as HeadersInit)
      expect(headers.get('Last-Event-ID')).toBe('evt-1')

      return createStreamingResponse([
        'id: evt-2\nevent: message\ndata: {"id":"m1","type":"text","data":{"content":"hello again"}}\n\n',
        'id: evt-3\nevent: done\ndata: {"sessionId":"sess-1","messageId":"done-1"}\n\n',
      ]) as Response
    })

    const resumed = renderHook(() =>
      useChat({
        sessionId: 'sess-1',
        onMessage,
        onComplete,
        onError,
      })
    )

    await act(async () => {
      await resumed.result.current.resumeSession()
    })

    await waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm1',
          type: 'text',
        })
      )
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          messageId: 'done-1',
        })
      )
    })

    expect(onError).not.toHaveBeenCalled()
  })

  it('retries resume stream after transient Load failed without surfacing an error', async () => {
    const onMessage = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()

    const fetchMock = vi.mocked(global.fetch)
    fetchMock
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(
        createStreamingResponse([
          'id: evt-10\nevent: message\ndata: {"id":"m2","type":"text","data":{"content":"after retry"}}\n\n',
          'id: evt-11\nevent: done\ndata: {"sessionId":"sess-2","messageId":"done-2"}\n\n',
        ]) as unknown as Response
      )

    const resumed = renderHook(() =>
      useChat({
        sessionId: 'sess-2',
        onMessage,
        onComplete,
        onError,
      })
    )

    await act(async () => {
      await resumed.result.current.resumeSession()
    })

    await waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm2',
          type: 'text',
        })
      )
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-2',
          messageId: 'done-2',
        })
      )
    })

    expect(onError).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops reconnecting after a completed terminal event', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()

    const fetchMock = vi.mocked(global.fetch)
    fetchMock.mockResolvedValueOnce(
      createStreamingResponse([
        'id: evt-15\nevent: done\ndata: {"sessionId":"sess-terminal","status":"completed","messageId":"done-terminal"}\n\n',
      ]) as unknown as Response
    )

    const { result } = renderHook(() =>
      useChat({
        sessionId: 'sess-terminal',
        onComplete,
        onError,
      })
    )

    await act(async () => {
      await result.current.resumeSession()
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-terminal',
          status: 'completed',
          messageId: 'done-terminal',
        })
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('supports awaiting approval terminal event and a later completed resume on the next reconnect', async () => {
    const onMessage = vi.fn()
    const onComplete = vi.fn()
    const onError = vi.fn()

    const fetchMock = vi.mocked(global.fetch)
    fetchMock
      .mockResolvedValueOnce(
        createStreamingResponse([
          'id: evt-20\nevent: done\ndata: {"sessionId":"sess-3","status":"awaiting_approval","pendingApprovalIds":["appr_1"]}\n\n',
        ]) as unknown as Response
      )
      .mockResolvedValueOnce(
        createStreamingResponse([
          'id: evt-21\nevent: message\ndata: {"id":"m3","type":"text","data":{"content":"final answer"}}\n\n',
          'id: evt-22\nevent: done\ndata: {"sessionId":"sess-3","status":"completed","messageId":"done-3"}\n\n',
        ]) as unknown as Response
      )

    const { result } = renderHook(() =>
      useChat({
        sessionId: 'sess-3',
        onMessage,
        onComplete,
        onError,
      })
    )

    await act(async () => {
      await result.current.resumeSession()
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sessionId: 'sess-3',
          status: 'awaiting_approval',
          pendingApprovalIds: ['appr_1'],
        })
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.resumeSession()
    })

    await waitFor(() => {
      expect(onComplete).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sessionId: 'sess-3',
          status: 'completed',
          messageId: 'done-3',
        })
      )
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'm3',
          type: 'text',
        })
      )
    })

    expect(onError).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops reconnecting after consecutive empty stream closures', async () => {
    const onComplete = vi.fn()
    const onError = vi.fn()

    const fetchMock = vi.mocked(global.fetch)
    fetchMock
      .mockResolvedValueOnce(createStreamingResponse([]) as unknown as Response)
      .mockResolvedValueOnce(createStreamingResponse([]) as unknown as Response)

    const { result } = renderHook(() =>
      useChat({
        sessionId: 'sess-empty',
        onComplete,
        onError,
      })
    )

    await act(async () => {
      await result.current.resumeSession()
    })

    await waitFor(() => {
      expect(result.current.isSending).toBe(false)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
