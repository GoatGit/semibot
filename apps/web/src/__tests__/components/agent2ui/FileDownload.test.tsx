import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileDownload } from '@/components/agent2ui/media/FileDownload'
import { DetailCanvas } from '@/components/layout/DetailCanvas'
import { useLayoutStore } from '@/stores/layoutStore'

vi.mock('@/components/providers/LocaleProvider', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      switch (key) {
        case 'agent2ui.fileDownload.unknownSize':
          return '未知大小'
        case 'agent2ui.fileDownload.downloadFile':
          return '下载文件'
        case 'agent2ui.fileDownload.openInDetail':
          return '打开详情'
        case 'agent2ui.fileDownload.markdownPreview':
          return 'Markdown 预览'
        case 'agent2ui.fileDownload.error.http':
          return `下载失败（HTTP ${params?.status}）`
        case 'agent2ui.fileDownload.error.invalidResponse':
          return '下载接口返回了错误响应'
        case 'loading.contentLoading':
          return '内容加载中'
        case 'detailCanvas.title':
          return '详情画布'
        case 'detailCanvas.collapse':
          return '收起详情画布'
        case 'detailCanvas.maximize':
          return '最大化详情画布'
        case 'detailCanvas.exitMaximize':
          return '退出最大化'
        case 'detailCanvas.expand':
          return '展开详情画布'
        case 'detailCanvas.emptyTitle':
          return '暂无详情内容'
        case 'detailCanvas.emptyDescription':
          return '这里会展示报告、文件与结构化结果'
        default:
          return key
      }
    },
  }),
}))

vi.mock('@/lib/api', () => ({
  getDirectApiBaseUrlForBrowser: () => 'http://127.0.0.1:3001/api/v1',
}))

describe('FileDownload markdown preview', () => {
  beforeEach(() => {
    useLayoutStore.setState({
      detailCanvasMode: 'collapsed',
      hasDetailContent: false,
      detailContent: null,
      currentPath: '/chat/test',
    })
    vi.restoreAllMocks()
  })

  it('renders markdown preview and opens detail canvas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '# PDD Report\n\n- item 1\n- item 2',
      })
    )

    render(
      <>
        <FileDownload
          data={{
            url: '/files/pdd_report.md',
            filename: 'pdd_report.md',
            mimeType: 'text/markdown',
            size: 128,
          }}
        />
        <DetailCanvas />
      </>
    )

    await waitFor(() => {
      expect(screen.getByText('Markdown 预览')).toBeInTheDocument()
      expect(screen.getByText('PDD Report')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Markdown 预览'))

    await waitFor(() => {
      expect(useLayoutStore.getState().detailCanvasMode).toBe('normal')
      expect(screen.getAllByText('PDD Report').length).toBeGreaterThan(0)
    })
  })
})
