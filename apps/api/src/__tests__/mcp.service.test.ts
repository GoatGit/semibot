/**
 * MCP Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as mcpService from '../services/mcp.service'
import * as mcpRepository from '../repositories/mcp.repository'

// Mock repository
vi.mock('../repositories/mcp.repository')

const mockMcpRepository = mcpRepository as typeof mcpRepository & {
  countByOrg: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  findByIdAndOrg: ReturnType<typeof vi.fn>
  findAll: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  softDelete: ReturnType<typeof vi.fn>
}

describe('MCP Service', () => {
  const mockOrgId = 'org-123'
  const mockUserId = 'user-123'
  const mockServerId = 'server-123'

  const mockServerRow: mcpRepository.McpServerRow = {
    id: mockServerId,
    org_id: mockOrgId,
    name: 'Test MCP Server',
    description: 'A test MCP server',
    endpoint: 'npx -y @test/mcp-server',
    transport: 'stdio',
    auth_type: null,
    auth_config: null,
    tools: [{ name: 'testTool', description: 'A test tool' }],
    resources: [],
    status: 'disconnected',
    last_connected_at: null,
    is_active: true,
    created_by: mockUserId,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createMcpServer', () => {
    it('should create a new MCP server successfully', async () => {
      mockMcpRepository.countByOrg.mockResolvedValue(0)
      mockMcpRepository.create.mockResolvedValue(mockServerRow)

      const input = {
        name: 'Test MCP Server',
        endpoint: 'npx -y @test/mcp-server',
        transport: 'stdio' as const,
      }

      const result = await mcpService.createMcpServer(mockOrgId, mockUserId, input)

      expect(result).toBeDefined()
      expect(result.name).toBe('Test MCP Server')
      expect(result.orgId).toBe(mockOrgId)
      expect(mockMcpRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          name: 'Test MCP Server',
          createdBy: mockUserId,
        })
      )
    })

    it('should throw error when server limit exceeded', async () => {
      mockMcpRepository.countByOrg.mockResolvedValue(20)

      await expect(
        mcpService.createMcpServer(mockOrgId, mockUserId, {
          name: 'New Server',
          endpoint: 'http://localhost:3000',
          transport: 'http',
        })
      ).rejects.toThrow()
    })
  })

  describe('getMcpServer', () => {
    it('should return server when found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(mockServerRow)

      const result = await mcpService.getMcpServer(mockOrgId, mockServerId)

      expect(result).toBeDefined()
      expect(result.id).toBe(mockServerId)
      expect(result.name).toBe('Test MCP Server')
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(mcpService.getMcpServer(mockOrgId, 'non-existent')).rejects.toThrow()
    })
  })

  describe('listMcpServers', () => {
    it('should return paginated servers list', async () => {
      mockMcpRepository.findAll.mockResolvedValue({
        data: [mockServerRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await mcpService.listMcpServers(mockOrgId, { page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
      expect(mockMcpRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: mockOrgId,
          page: 1,
          limit: 20,
        })
      )
    })

    it('should support status filter', async () => {
      mockMcpRepository.findAll.mockResolvedValue({
        data: [],
        meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
      })

      await mcpService.listMcpServers(mockOrgId, { status: 'connected' })

      expect(mockMcpRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'connected',
        })
      )
    })
  })

  describe('updateMcpServer', () => {
    it('should update server successfully', async () => {
      mockMcpRepository.update.mockResolvedValue({
        ...mockServerRow,
        name: 'Updated Server',
      })

      const result = await mcpService.updateMcpServer(mockOrgId, mockServerId, {
        name: 'Updated Server',
      })

      expect(result.name).toBe('Updated Server')
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
        mockOrgId,
        expect.objectContaining({ name: 'Updated Server' })
      )
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.update.mockResolvedValue(null)

      await expect(
        mcpService.updateMcpServer(mockOrgId, 'non-existent', { name: 'Updated' })
      ).rejects.toThrow()
    })
  })

  describe('deleteMcpServer', () => {
    it('should delete server successfully', async () => {
      mockMcpRepository.softDelete.mockResolvedValue(true)

      await expect(mcpService.deleteMcpServer(mockOrgId, mockServerId)).resolves.not.toThrow()

      expect(mockMcpRepository.softDelete).toHaveBeenCalledWith(mockServerId, mockOrgId)
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.softDelete.mockResolvedValue(false)

      await expect(mcpService.deleteMcpServer(mockOrgId, 'non-existent')).rejects.toThrow()
    })
  })

  describe('testConnection', () => {
    it('should update status to connecting when testing', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(mockServerRow)
      mockMcpRepository.update.mockResolvedValue({
        ...mockServerRow,
        status: 'connecting',
      })

      // testConnection 会尝试真实连接，这里只验证状态更新逻辑
      // 由于 stdio 连接需要真实进程，预期会失败
      try {
        await mcpService.testConnection(mockOrgId, mockServerId)
      } catch {
        // 预期连接失败，但应该已经更新了状态
      }

      // 验证调用了 update 来设置 connecting 状态
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
        mockOrgId,
        expect.objectContaining({ status: 'connecting' })
      )
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(mcpService.testConnection(mockOrgId, 'non-existent')).rejects.toThrow()
    })

    it('should update status to error on connection failure', async () => {
      const httpServerRow = {
        ...mockServerRow,
        transport: 'http' as const,
        endpoint: 'http://invalid-server-12345.example.com/mcp',
      }

      mockMcpRepository.findByIdAndOrg.mockResolvedValue(httpServerRow)
      mockMcpRepository.update.mockResolvedValue({
        ...httpServerRow,
        status: 'error',
      })

      // HTTP 连接到无效服务器应该失败
      await expect(mcpService.testConnection(mockOrgId, mockServerId)).rejects.toThrow()

      // 验证调用了 update 来设置 error 状态
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
        mockOrgId,
        expect.objectContaining({ status: 'error' })
      )
    })
  })

  describe('syncToolsAndResources', () => {
    it('should sync tools and resources', async () => {
      const tools = [{ name: 'newTool', description: 'A new tool' }]
      const resources = [{ uri: 'file://test', name: 'Test Resource' }]

      mockMcpRepository.update.mockResolvedValue({
        ...mockServerRow,
        tools,
        resources,
      })

      const result = await mcpService.syncToolsAndResources(
        mockOrgId,
        mockServerId,
        tools,
        resources
      )

      expect(result.tools).toEqual(tools)
      expect(result.resources).toEqual(resources)
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.update.mockResolvedValue(null)

      await expect(
        mcpService.syncToolsAndResources(mockOrgId, 'non-existent', [], [])
      ).rejects.toThrow()
    })
  })
})
