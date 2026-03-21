import type { ImgHTMLAttributes } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NavBar } from '@/components/layout/NavBar'
import { useLayoutStore } from '@/stores/layoutStore'

const getMock = vi.fn()
const openMock = vi.fn()
const writeTextMock = vi.fn()

vi.mock('next/image', () => ({
  default: ({ alt, priority: _priority, ...props }: ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => (
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
        'nav.rules': '规则',
        'help.nav.rules': '查看规则',
        'nav.approvals': '审批',
        'help.nav.approvals': '查看审批',
        'nav.usage': '用量',
        'help.nav.usage': '查看用量',
        'nav.agents': '智能体',
        'help.nav.agents': '查看智能体',
        'nav.studio': 'Studio',
        'help.nav.studio': '查看 Studio',
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
  },
}))

describe('NavBar version actions', () => {
  const originalOpen = window.open
  const originalClipboard = navigator.clipboard

  beforeEach(() => {
    vi.clearAllMocks()
    useLayoutStore.setState({ navBarExpanded: true })
    Object.defineProperty(window, 'open', {
      value: openMock,
      writable: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
    })

    getMock.mockImplementation(async (path: string) => {
      if (path === '/health') return { success: true }
      if (path === '/runtime/health') return { data: { available: true } }
      if (path === '/version') {
        return {
          data: {
            currentVersion: '2026.03.21.06',
            latestVersion: '2026.03.21.07',
            updateAvailable: true,
            releaseUrl: 'https://releases.semibot.ai/stable/semibot-2026.03.21.07.tar.gz',
            releaseNotesUrl: 'https://semibot.ai/releases/2026.03.21.07',
            upgradeCommand: 'semibot upgrade --manifest-url https://releases.semibot.ai/stable/latest.json',
          },
        }
      }
      throw new Error(`unexpected path: ${path}`)
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'open', {
      value: originalOpen,
      writable: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    })
  })

  it('detects newer version and opens release url on version click', async () => {
    render(<NavBar />)

    await screen.findByText('v2026.03.21.06')
    await screen.findByText('→ 2026.03.21.07')

    const versionButton = screen.getByTitle('发现新版本 2026.03.21.07，当前 2026.03.21.06')
    fireEvent.click(versionButton)

    expect(openMock).toHaveBeenCalledWith(
      'https://releases.semibot.ai/stable/semibot-2026.03.21.07.tar.gz',
      '_blank',
      'noopener,noreferrer'
    )
  })

  it('copies upgrade command and opens release notes', async () => {
    writeTextMock.mockResolvedValue(undefined)

    render(<NavBar />)

    await screen.findByText('复制升级命令')

    fireEvent.click(screen.getByRole('button', { name: '复制升级命令' }))

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith(
        'semibot upgrade --manifest-url https://releases.semibot.ai/stable/latest.json'
      )
    })
    expect(screen.getByText('已复制升级命令')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '发布说明' }))
    expect(openMock).toHaveBeenCalledWith(
      'https://semibot.ai/releases/2026.03.21.07',
      '_blank',
      'noopener,noreferrer'
    )
  })
})
