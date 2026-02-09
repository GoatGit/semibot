/**
 * ErrorView 组件测试
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ErrorView } from '@/components/agent2ui/feedback/ErrorView'
import type { ErrorData } from '@/types'

describe('ErrorView', () => {
  const baseData: ErrorData = {
    code: 'ERR_UNKNOWN',
    message: '发生了一个错误',
  }

  describe('基础渲染', () => {
    it('应该显示错误消息', () => {
      render(<ErrorView data={baseData} />)

      expect(screen.getByText('发生了一个错误')).toBeInTheDocument()
    })

    it('应该显示错误图标', () => {
      const { container } = render(<ErrorView data={baseData} />)

      // 查找 SVG 图标
      expect(container.querySelector('svg')).toBeInTheDocument()
    })

    it('应该显示错误代码', () => {
      const data: ErrorData = {
        message: '错误消息',
        code: 'ERR_NETWORK',
      }

      render(<ErrorView data={data} />)

      expect(screen.getByText('ERR_NETWORK')).toBeInTheDocument()
    })
  })

  describe('详情显示', () => {
    it('应该显示错误详情', () => {
      const data: ErrorData = {
        code: 'ERR_TIMEOUT',
        message: '错误消息',
        details: '详细错误信息：连接超时',
      }

      render(<ErrorView data={data} />)

      expect(screen.getByText(/详细错误信息/)).toBeInTheDocument()
    })

    it('应该显示详细的错误信息对象', () => {
      const data: ErrorData = {
        code: 'ERR_INTERNAL',
        message: '错误消息',
        details: 'Error: Something went wrong\n  at function1\n  at function2',
      }

      render(<ErrorView data={data} />)

      expect(screen.getByText(/Error: Something went wrong/)).toBeInTheDocument()
    })
  })

  describe('样式', () => {
    it('应该有错误样式', () => {
      const { container } = render(<ErrorView data={baseData} />)

      // 检查有红色相关的样式类
      const wrapper = container.firstChild as HTMLElement
      expect(wrapper.className).toMatch(/error|red/)
    })

    it('应该接受自定义 className', () => {
      const { container } = render(
        <ErrorView data={baseData} className="custom-error" />
      )

      expect(container.firstChild).toHaveClass('custom-error')
    })
  })
})
