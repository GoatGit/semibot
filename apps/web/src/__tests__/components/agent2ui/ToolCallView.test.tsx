/**
 * ToolCallView 组件测试
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ToolCallView } from '@/components/agent2ui/process/ToolCallView'
import type { ToolCallData } from '@/types'

describe('ToolCallView', () => {
  const baseData: ToolCallData = {
    toolName: 'web_search',
    arguments: { query: 'test query' },
    status: 'calling',
  }

  describe('状态显示', () => {
    it('应该显示执行中状态', () => {
      const data: ToolCallData = { ...baseData, status: 'calling' }

      render(<ToolCallView data={data} />)

      expect(screen.getByText('web_search')).toBeInTheDocument()
      expect(screen.getByText('执行中')).toBeInTheDocument()
    })

    it('应该显示成功状态', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Search results',
        duration: 1500,
      }

      render(<ToolCallView data={data} />)

      expect(screen.getByText('成功 · 1.5s')).toBeInTheDocument()
    })

    it('应该显示失败状态', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'error',
        result: 'Error message',
        duration: 500,
      }

      render(<ToolCallView data={data} />)

      expect(screen.getByText('失败 · 0.5s')).toBeInTheDocument()
    })

    it('成功时无持续时间应该只显示成功', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Done',
      }

      render(<ToolCallView data={data} />)

      expect(screen.getByText('成功')).toBeInTheDocument()
    })
  })

  describe('展开/收起功能', () => {
    it('默认应该是收起状态', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Result data',
      }

      render(<ToolCallView data={data} />)

      // 参数和结果默认不可见
      expect(screen.queryByText('参数')).not.toBeInTheDocument()
      expect(screen.queryByText('结果')).not.toBeInTheDocument()
    })

    it('点击头部应该展开内容', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Result data',
      }

      render(<ToolCallView data={data} />)

      // 点击展开
      fireEvent.click(screen.getByText('web_search'))

      // 现在应该可见
      expect(screen.getByText('参数')).toBeInTheDocument()
      expect(screen.getByText('结果')).toBeInTheDocument()
    })

    it('再次点击应该收起', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Result data',
      }

      render(<ToolCallView data={data} />)

      // 展开
      fireEvent.click(screen.getByText('web_search'))
      expect(screen.getByText('参数')).toBeInTheDocument()

      // 收起
      fireEvent.click(screen.getByText('web_search'))
      expect(screen.queryByText('参数')).not.toBeInTheDocument()
    })
  })

  describe('参数和结果显示', () => {
    it('应该显示 JSON 格式的参数', () => {
      const data: ToolCallData = {
        ...baseData,
        arguments: { query: 'test', limit: 10 },
        status: 'success',
      }

      render(<ToolCallView data={data} />)
      fireEvent.click(screen.getByText('web_search'))

      // 检查 JSON 格式化的参数
      expect(screen.getByText(/"query": "test"/)).toBeInTheDocument()
      expect(screen.getByText(/"limit": 10/)).toBeInTheDocument()
    })

    it('应该显示字符串结果', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Simple string result',
      }

      render(<ToolCallView data={data} />)
      fireEvent.click(screen.getByText('web_search'))

      expect(screen.getByText('Simple string result')).toBeInTheDocument()
    })

    it('应该显示 JSON 格式的对象结果', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: { items: [1, 2, 3], total: 3 },
      }

      render(<ToolCallView data={data} />)
      fireEvent.click(screen.getByText('web_search'))

      expect(screen.getByText(/"total": 3/)).toBeInTheDocument()
    })

    it('空参数时不应该显示参数区域', () => {
      const data: ToolCallData = {
        toolName: 'get_time',
        arguments: {},
        status: 'success',
        result: '2024-01-01',
      }

      render(<ToolCallView data={data} />)
      fireEvent.click(screen.getByText('get_time'))

      expect(screen.queryByText('参数')).not.toBeInTheDocument()
      expect(screen.getByText('结果')).toBeInTheDocument()
    })
  })

  describe('重试按钮', () => {
    it('错误状态且提供 onRetry 时应该显示重试按钮', () => {
      const onRetry = vi.fn()
      const data: ToolCallData = {
        ...baseData,
        status: 'error',
        result: 'Failed',
      }

      render(<ToolCallView data={data} onRetry={onRetry} />)

      expect(screen.getByText('重试')).toBeInTheDocument()
    })

    it('点击重试按钮应该调用 onRetry', () => {
      const onRetry = vi.fn()
      const data: ToolCallData = {
        ...baseData,
        status: 'error',
        result: 'Failed',
      }

      render(<ToolCallView data={data} onRetry={onRetry} />)
      fireEvent.click(screen.getByText('重试'))

      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('成功状态不应该显示重试按钮', () => {
      const onRetry = vi.fn()
      const data: ToolCallData = {
        ...baseData,
        status: 'success',
        result: 'Done',
      }

      render(<ToolCallView data={data} onRetry={onRetry} />)

      expect(screen.queryByText('重试')).not.toBeInTheDocument()
    })

    it('无 onRetry 回调时不应该显示重试按钮', () => {
      const data: ToolCallData = {
        ...baseData,
        status: 'error',
        result: 'Failed',
      }

      render(<ToolCallView data={data} />)

      expect(screen.queryByText('重试')).not.toBeInTheDocument()
    })
  })

  describe('样式类名', () => {
    it('应该接受自定义 className', () => {
      const { container } = render(
        <ToolCallView data={baseData} className="custom-class" />
      )

      expect(container.firstChild).toHaveClass('custom-class')
    })

    it('执行中状态应该有进度条', () => {
      const data: ToolCallData = { ...baseData, status: 'calling' }

      const { container } = render(<ToolCallView data={data} />)

      // 检查进度条动画元素
      expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
    })
  })
})
