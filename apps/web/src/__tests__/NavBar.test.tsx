import type { ImgHTMLAttributes } from 'react'
import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NavBar } from '@/components/layout/NavBar'
import { useLayoutStore } from '@/stores/layoutStore'

const getMock = vi.fn()
const postMock = vi.fn()
const openMock = vi.fn()

vi.mock('next/image', () => ({
  default: ({ alt, priority: _priority, ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => (
    // Test stub for next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}))

vi.mock('@/components/providers/LocaleProvider', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    setLocale: vi.fn(),
    t: (key: string) => {
      const map: Record<string, string> = {
        'nav.dashboard': '仪表盘',
        'help.nav.dashboard': '查看系统总览',
        'nav.sessions': '会话',
        'help.nav.sessions': '查看会话',
        'nav.events': '事件',
        'help.nav.events': '查看事件',
        'nav.runtimeMonitor': 'Runtime 监控',
        'help.nav.runtimeMonitor': '查看 runtime 监控',
        'nav.rules': '规则',
        'help.nav.rules': '查看规则',
        'nav.approvals': '审批',
        'help.nav.approvals': '查看审批',
        'nav.usage': '用量',
        'help.nav.usage': '查看用量',
        'nav.agents': '智能体',
        'help.nav.agents': '查看智能体',
        'nav.studio': '工作室',
        'help.nav.studio': '查看工作室',
        'nav.skills': '技能',
        'help.nav.skills': '查看技能',
        'nav.mcpServers': 'MCP 服务器',
        'help.nav.mcpServers': '查看 MCP 服务器',
        'nav.tools': '工具',
        'help.nav.tools': '查看工具',
        'nav.config': '配置',
        'help.nav.config': '查看配置',
        'nav.helpCenter': '帮助中心',
        'nav.languageOptions.zh-CN': '简体中文',
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('@/components/providers/ThemeProvider', () => ({
  useTheme: () => ({
    theme: 'dark',
    setTheme: vi.fn(),
  }),
}))

vi.mock('@/lib/api', () => ({
  apiClient: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}))

describe('NavBar version actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    useLayoutStore.setState({ navBarExpanded: true })
    Object.defineProperty(window, 'open', {
      value: openMock,
      writable: true,
      configurable: true,
    })
    postMock.mockResolvedValue({
      data: {
        status: 'queued',
        message: '升级任务已提交',
        error: null,
      },
    })

    getMock.mockImplementation(async (path: string) => {
      if (path === '/health') return { success: true }
      if (path === '/runtime/health') return { data: { available: true } }
      if (path === '/version/upgrade') {
        return {
          data: {
            status: 'idle',
            message: null,
            error: null,
          },
        }
      }
      if (path === '/version') {
        return {
          data: {
            currentVersion: '2026.03.21.06',
            latestVersion: '2026.03.21.07',
            updateAvailable: true,
            releaseNotesUrl: 'https://semibot.ai/releases/2026.03.21.07',
          },
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects newer version and submits background upgrade', async () => {
    render(<NavBar />)

    await screen.findByText('2026.03.21.06')
    await screen.findByText('发现新版本 2026.03.21.07')

    fireEvent.click(screen.getByRole('button', { name: '立即更新' }))

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith('/version/upgrade', {})
    })
  })

  it('opens release notes', async () => {
    render(<NavBar />)

    await screen.findByRole('button', { name: '发布说明' })
    fireEvent.click(screen.getByRole('button', { name: '发布说明' }))

    expect(openMock).toHaveBeenCalledWith(
      'https://semibot.ai/releases/2026.03.21.07',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('stops upgrade polling while status is terminal', async () => {
    vi.useFakeTimers()
    let versionUpgradeReads = 0
    getMock.mockImplementation(async (path: string) => {
      if (path === '/health') return { success: true }
      if (path === '/runtime/health') return { data: { available: true } }
      if (path === '/version/upgrade') {
        versionUpgradeReads += 1
        return {
          data: {
            status: 'idle',
            message: null,
            error: null,
          },
        }
      }
      if (path === '/version') {
        return {
          data: {
            currentVersion: '2026.03.21.06',
            latestVersion: '2026.03.21.07',
            updateAvailable: true,
            releaseNotesUrl: 'https://semibot.ai/releases/2026.03.21.07',
          },
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    render(<NavBar />)

    await act(async () => {
      await Promise.resolve()
    })
    expect(versionUpgradeReads).toBeGreaterThan(0)
    const callsAfterMount = versionUpgradeReads

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })

    expect(versionUpgradeReads).toBe(callsAfterMount)
    vi.useRealTimers()
  })

  it('renders upgrade errors in a scrollable bounded container', async () => {
    getMock.mockImplementation(async (path: string) => {
      if (path === '/health') return { success: true }
      if (path === '/runtime/health') return { data: { available: true } }
      if (path === '/version/upgrade') {
        return {
          data: {
            status: 'failed',
            message: '升级失败',
            error: 'very long upgrade error output',
          },
        }
      }
      if (path === '/version') {
        return {
          data: {
            currentVersion: '2026.03.21.06',
            latestVersion: '2026.03.21.07',
            updateAvailable: true,
            releaseNotesUrl: null,
          },
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })

    render(<NavBar />)

    const errorBox = await screen.findByTitle('升级错误详情')
    expect(errorBox.className).toContain('max-h-32')
    expect(errorBox.className).toContain('overflow-y-auto')
    expect(errorBox).toHaveTextContent('very long upgrade error output')
  })
})
