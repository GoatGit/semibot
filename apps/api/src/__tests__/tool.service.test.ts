import { describe, expect, it, vi } from 'vitest'

vi.mock('../repositories/tool.repository', () => ({
  findAll: vi.fn(),
}))

describe('tool service', () => {
  it('filters before paginating so metadata stays consistent', async () => {
    const toolRepository = await import('../repositories/tool.repository')
    const service = await import('../services/tool.service')

    vi.mocked(toolRepository.findAll).mockResolvedValue({
      data: [
        {
          id: '1',
          org_id: null,
          name: 'search',
          description: 'search',
          type: 'builtin',
          schema: {},
          config: {},
          is_builtin: true,
          is_active: true,
          created_by: null,
          created_at: '2026-03-24T00:00:00Z',
          updated_at: '2026-03-24T00:00:00Z',
        },
        {
          id: '2',
          org_id: null,
          name: 'code_executor',
          description: 'code',
          type: 'builtin',
          schema: {},
          config: {},
          is_builtin: true,
          is_active: true,
          created_by: null,
          created_at: '2026-03-24T00:00:00Z',
          updated_at: '2026-03-24T00:00:00Z',
        },
      ],
      meta: {
        total: 2,
        page: 1,
        limit: 100,
        totalPages: 1,
      },
    })

    const result = await service.listTools({ page: 2, limit: 1 })

    expect(toolRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 100,
      })
    )
    expect(result.data).toHaveLength(1)
    expect(result.data[0]?.name).toBe('code_executor')
    expect(result.meta).toMatchObject({
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    })
  })
})
