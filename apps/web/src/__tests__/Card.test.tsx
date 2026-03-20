/**
 * Card 组件测试
 */

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'

describe('Card Component', () => {
  it('should render Card with children', () => {
    render(<Card>Card Content</Card>)
    expect(screen.getByText('Card Content')).toBeInTheDocument()
  })

  it('should render Card with interactive style', () => {
    render(<Card interactive>Interactive Card</Card>)
    expect(screen.getByText('Interactive Card')).toBeInTheDocument()
  })

  it('should render CardHeader', () => {
    render(
      <Card>
        <CardHeader>Header Content</CardHeader>
      </Card>
    )
    expect(screen.getByText('Header Content')).toBeInTheDocument()
  })

  it('should render CardTitle', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
        </CardHeader>
      </Card>
    )
    expect(screen.getByText('Title')).toBeInTheDocument()
  })

  it('should render CardDescription', () => {
    render(
      <Card>
        <CardHeader>
          <CardDescription>Description text</CardDescription>
        </CardHeader>
      </Card>
    )
    expect(screen.getByText('Description text')).toBeInTheDocument()
  })

  it('should render CardContent', () => {
    render(
      <Card>
        <CardContent>Content text</CardContent>
      </Card>
    )
    expect(screen.getByText('Content text')).toBeInTheDocument()
  })

  it('should render complete card structure', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card description</CardDescription>
        </CardHeader>
        <CardContent>Card body content</CardContent>
      </Card>
    )

    expect(screen.getByText('Card Title')).toBeInTheDocument()
    expect(screen.getByText('Card description')).toBeInTheDocument()
    expect(screen.getByText('Card body content')).toBeInTheDocument()
  })
})
