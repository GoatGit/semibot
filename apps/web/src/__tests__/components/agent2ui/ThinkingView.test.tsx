/**
 * ThinkingView 组件测试
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ThinkingView } from '@/components/agent2ui/process/ThinkingView'
import type { ThinkingData } from '@/types'

describe('ThinkingView', () => {
  describe('内容渲染', () => {
    it('应该渲染思考标题', () => {
      const data: ThinkingData = { content: '分析用户请求' }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('正在思考...')).toBeInTheDocument()
    })

    it('应该渲染单行内容', () => {
      const data: ThinkingData = { content: '这是思考内容' }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('这是思考内容')).toBeInTheDocument()
    })

    it('应该渲染多行内容', () => {
      const data: ThinkingData = {
        content: '第一行思考\n第二行思考\n第三行思考',
      }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('第一行思考')).toBeInTheDocument()
      expect(screen.getByText('第二行思考')).toBeInTheDocument()
      expect(screen.getByText('第三行思考')).toBeInTheDocument()
    })

    it('应该过滤空行', () => {
      const data: ThinkingData = {
        content: '第一行\n\n\n第二行',
      }

      const { container } = render(<ThinkingView data={data} />)

      // 只有两个内容行
      const contentLines = container.querySelectorAll('.animate-fade-in-up')
      expect(contentLines).toHaveLength(2)
    })
  })

  describe('列表项处理', () => {
    it('应该识别 > 开头的列表项', () => {
      const data: ThinkingData = {
        content: '> 分析需求\n> 设计方案',
      }

      render(<ThinkingView data={data} />)

      // 检查列表项内容（去掉前缀）
      expect(screen.getByText('分析需求')).toBeInTheDocument()
      expect(screen.getByText('设计方案')).toBeInTheDocument()
    })

    it('应该识别 - 开头的列表项', () => {
      const data: ThinkingData = {
        content: '- 第一步\n- 第二步',
      }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('第一步')).toBeInTheDocument()
      expect(screen.getByText('第二步')).toBeInTheDocument()
    })

    it('应该识别 * 开头的列表项', () => {
      const data: ThinkingData = {
        content: '* 任务一\n* 任务二',
      }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('任务一')).toBeInTheDocument()
      expect(screen.getByText('任务二')).toBeInTheDocument()
    })

    it('列表项应该显示箭头符号', () => {
      const data: ThinkingData = {
        content: '> 列表项',
      }

      render(<ThinkingView data={data} />)

      expect(screen.getByText('›')).toBeInTheDocument()
    })
  })

  describe('动画效果', () => {
    it('应该有脉冲动画元素', () => {
      const data: ThinkingData = { content: '思考中' }

      const { container } = render(<ThinkingView data={data} />)

      // 检查脉冲动画
      expect(container.querySelector('.animate-ping')).toBeInTheDocument()
    })

    it('应该有思考点动画', () => {
      const data: ThinkingData = { content: '思考中' }

      const { container } = render(<ThinkingView data={data} />)

      // 三个脉冲点
      const pulsingDots = container.querySelectorAll('.animate-pulse')
      expect(pulsingDots.length).toBeGreaterThanOrEqual(3)
    })

    it('每行应该有渐入动画', () => {
      const data: ThinkingData = {
        content: '第一行\n第二行',
      }

      const { container } = render(<ThinkingView data={data} />)

      const animatedLines = container.querySelectorAll('.animate-fade-in-up')
      expect(animatedLines).toHaveLength(2)
    })

    it('动画延迟应该递增', () => {
      const data: ThinkingData = {
        content: '第一行\n第二行\n第三行',
      }

      const { container } = render(<ThinkingView data={data} />)

      const animatedLines = container.querySelectorAll('.animate-fade-in-up')

      // 检查动画延迟
      expect(animatedLines[0]).toHaveStyle({ animationDelay: '0ms' })
      expect(animatedLines[1]).toHaveStyle({ animationDelay: '100ms' })
      expect(animatedLines[2]).toHaveStyle({ animationDelay: '200ms' })
    })
  })

  describe('样式', () => {
    it('应该接受自定义 className', () => {
      const data: ThinkingData = { content: '思考' }

      const { container } = render(
        <ThinkingView data={data} className="custom-thinking" />
      )

      expect(container.firstChild).toHaveClass('custom-thinking')
    })

    it('应该有正确的基础样式类', () => {
      const data: ThinkingData = { content: '思考' }

      const { container } = render(<ThinkingView data={data} />)

      expect(container.firstChild).toHaveClass('rounded-lg')
      expect(container.firstChild).toHaveClass('border')
    })
  })
})
