/**
 * Agent2UIRenderer 组件测试
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Agent2UIRenderer, Agent2UIMessageList } from '@/components/agent2ui/Agent2UIRenderer'
import type { Agent2UIMessage } from '@/types'

// Mock ComponentRegistry
vi.mock('@/components/agent2ui/ComponentRegistry', () => ({
  ComponentRegistry: {
    get: vi.fn((type: string) => {
      if (type === 'unknown_type') return undefined
      if (type === 'error_component') {
        const ErrorComponent = (): JSX.Element => {
          throw new Error('Component error')
        }
        ErrorComponent.displayName = 'ErrorComponent'
        return ErrorComponent
      }
      const MockComponent = ({ data }: { data: { content: string } }): JSX.Element => (
        <div data-testid="mock-component">{data.content}</div>
      )
      MockComponent.displayName = 'MockComponent'
      return MockComponent
    }),
  },
}))

// Mock TextBlock
vi.mock('@/components/agent2ui/text/TextBlock', () => ({
  TextBlock: ({ data }: { data: { content: string } }) => (
    <div data-testid="text-block">{data.content}</div>
  ),
}))

describe('Agent2UIRenderer', () => {
  describe('正常渲染', () => {
    it('应该渲染已注册的组件', () => {
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'text',
        data: { content: 'Hello World' },
      }

      render(<Agent2UIRenderer message={message} />)

      expect(screen.getByTestId('mock-component')).toHaveTextContent('Hello World')
    })

    it('应该添加正确的 CSS 类名', () => {
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'text',
        data: { content: 'Test' },
      }

      const { container } = render(<Agent2UIRenderer message={message} className="custom-class" />)

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper).toHaveClass('agent2ui-message')
      expect(wrapper).toHaveClass('agent2ui-text')
      expect(wrapper).toHaveClass('custom-class')
    })

    it('应该设置 data 属性', () => {
      const message: Agent2UIMessage = {
        id: 'msg-123',
        type: 'markdown',
        data: { content: '# Title' },
      }

      const { container } = render(<Agent2UIRenderer message={message} />)

      const wrapper = container.firstChild as HTMLElement
      expect(wrapper).toHaveAttribute('data-message-id', 'msg-123')
      expect(wrapper).toHaveAttribute('data-message-type', 'markdown')
    })
  })

  describe('未知类型处理', () => {
    it('应该对未知类型显示回退内容', () => {
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'unknown_type' as Agent2UIMessage['type'],
        data: { content: 'Fallback content' },
      }

      render(<Agent2UIRenderer message={message} />)

      expect(screen.getByTestId('text-block')).toBeInTheDocument()
    })

    it('应该将对象数据序列化为 JSON', () => {
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'unknown_type' as Agent2UIMessage['type'],
        data: { key: 'value', nested: { a: 1 } },
      }

      render(<Agent2UIRenderer message={message} />)

      expect(screen.getByTestId('text-block')).toBeInTheDocument()
    })
  })

  describe('错误处理', () => {
    it('应该捕获组件渲染错误并显示错误信息', () => {
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'error_component' as Agent2UIMessage['type'],
        data: { content: 'Test' },
      }

      const { container } = render(<Agent2UIRenderer message={message} />)

      expect(container.textContent).toContain('渲染失败')
    })

    it('应该调用 onError 回调', () => {
      const onError = vi.fn()
      const message: Agent2UIMessage = {
        id: 'msg-1',
        type: 'error_component' as Agent2UIMessage['type'],
        data: { content: 'Test' },
      }

      render(<Agent2UIRenderer message={message} onError={onError} />)

      expect(onError).toHaveBeenCalledWith(expect.any(Error), message)
    })
  })
})

describe('Agent2UIMessageList', () => {
  it('应该渲染多条消息', () => {
    const messages: Agent2UIMessage[] = [
      { id: 'msg-1', type: 'text', data: { content: 'Message 1' } },
      { id: 'msg-2', type: 'text', data: { content: 'Message 2' } },
      { id: 'msg-3', type: 'text', data: { content: 'Message 3' } },
    ]

    render(<Agent2UIMessageList messages={messages} />)

    expect(screen.getAllByTestId('mock-component')).toHaveLength(3)
  })

  it('应该使用不同的 gap 样式', () => {
    const messages: Agent2UIMessage[] = [
      { id: 'msg-1', type: 'text', data: { content: 'Test' } },
    ]

    const { container, rerender } = render(
      <Agent2UIMessageList messages={messages} gap="sm" />
    )
    expect(container.firstChild).toHaveClass('space-y-2')

    rerender(<Agent2UIMessageList messages={messages} gap="md" />)
    expect(container.firstChild).toHaveClass('space-y-4')

    rerender(<Agent2UIMessageList messages={messages} gap="lg" />)
    expect(container.firstChild).toHaveClass('space-y-6')
  })

  it('应该传递 messageClassName 到每条消息', () => {
    const messages: Agent2UIMessage[] = [
      { id: 'msg-1', type: 'text', data: { content: 'Test' } },
    ]

    const { container } = render(
      <Agent2UIMessageList messages={messages} messageClassName="message-class" />
    )

    const messageWrapper = container.querySelector('.agent2ui-message')
    expect(messageWrapper).toHaveClass('message-class')
  })

  it('应该处理空消息列表', () => {
    const { container } = render(<Agent2UIMessageList messages={[]} />)

    expect(container.firstChild?.childNodes).toHaveLength(0)
  })
})
