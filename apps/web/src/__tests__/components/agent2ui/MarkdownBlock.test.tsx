/**
 * MarkdownBlock 组件测试
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MarkdownBlock } from '@/components/agent2ui/text/MarkdownBlock'
import type { MarkdownData } from '@/types'

describe('MarkdownBlock', () => {
  describe('基础渲染', () => {
    it('应该渲染简单文本', () => {
      const data: MarkdownData = { content: 'Hello World' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('Hello World')).toBeInTheDocument()
    })

    it('应该渲染标题', () => {
      const data: MarkdownData = { content: '# 一级标题\n## 二级标题' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('一级标题')
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('二级标题')
    })

    it('应该渲染列表', () => {
      const data: MarkdownData = { content: '- 项目1\n- 项目2\n- 项目3' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('项目1')).toBeInTheDocument()
      expect(screen.getByText('项目2')).toBeInTheDocument()
      expect(screen.getByText('项目3')).toBeInTheDocument()
    })

    it('应该渲染链接', () => {
      const data: MarkdownData = { content: '[链接文字](https://example.com)' }

      render(<MarkdownBlock data={data} />)

      const link = screen.getByRole('link', { name: '链接文字' })
      expect(link).toHaveAttribute('href', 'https://example.com')
    })

    it('应该渲染代码块', () => {
      const data: MarkdownData = { content: '`inline code`' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('inline code')).toBeInTheDocument()
    })

    it('应该渲染加粗和斜体', () => {
      const data: MarkdownData = { content: '**加粗** 和 *斜体*' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('加粗')).toBeInTheDocument()
      expect(screen.getByText('斜体')).toBeInTheDocument()
    })
  })

  describe('GFM 支持', () => {
    it('应该渲染表格', () => {
      const data: MarkdownData = {
        content: '| 列1 | 列2 |\n|-----|-----|\n| A | B |',
      }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByRole('table')).toBeInTheDocument()
      expect(screen.getByText('列1')).toBeInTheDocument()
      expect(screen.getByText('A')).toBeInTheDocument()
    })

    it('应该渲染任务列表', () => {
      const data: MarkdownData = {
        content: '- [x] 已完成\n- [ ] 未完成',
      }

      render(<MarkdownBlock data={data} />)

      const checkboxes = screen.getAllByRole('checkbox')
      expect(checkboxes).toHaveLength(2)
    })

    it('应该渲染删除线', () => {
      const data: MarkdownData = { content: '~~删除的文字~~' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('删除的文字')).toBeInTheDocument()
    })
  })

  describe('样式', () => {
    it('应该有 prose 样式类', () => {
      const data: MarkdownData = { content: 'Test' }

      const { container } = render(<MarkdownBlock data={data} />)

      expect(container.firstChild).toHaveClass('prose')
      expect(container.firstChild).toHaveClass('prose-invert')
    })

    it('应该接受自定义 className', () => {
      const data: MarkdownData = { content: 'Test' }

      const { container } = render(
        <MarkdownBlock data={data} className="custom-markdown" />
      )

      expect(container.firstChild).toHaveClass('custom-markdown')
    })

    it('应该有 max-w-none 避免内容宽度限制', () => {
      const data: MarkdownData = { content: 'Test' }

      const { container } = render(<MarkdownBlock data={data} />)

      expect(container.firstChild).toHaveClass('max-w-none')
    })
  })

  describe('复杂内容', () => {
    it('应该渲染复杂的 Markdown 内容', () => {
      const data: MarkdownData = {
        content: `# 标题

这是一段文字，包含**加粗**和*斜体*。

## 列表

- 项目 1
- 项目 2

## 代码

\`inline code\`

## 链接

[示例链接](https://example.com)
`,
      }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
      expect(screen.getByRole('heading', { level: 2, name: '列表' })).toBeInTheDocument()
      expect(screen.getByText('加粗')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: '示例链接' })).toBeInTheDocument()
    })

    it('应该渲染引用块', () => {
      const data: MarkdownData = { content: '> 这是一段引用' }

      render(<MarkdownBlock data={data} />)

      expect(screen.getByText('这是一段引用')).toBeInTheDocument()
    })
  })
})
