/**
 * MCP Service 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as mcpService from '../services/mcp.service'
import * as mcpRepository from '../repositories/mcp.repository'

// Mock repository
vi.mock('../repositories/mcp.repository')
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    async connect() {
      throw new Error('mock connection failure')
    }
    async listTools() {
      return { tools: [] }
    }
    async listResources() {
      return { resources: [] }
    }
    async close() {
      return undefined
    }
  },
}))

const mockMcpRepository = mcpRepository as typeof mcpRepository & {
  countByOrg: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  findByIdAndOrg: ReturnType<typeof vi.fn>
  findAll: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  softDelete: ReturnType<typeof vi.fn>
}

describe('MCP Service', () => {
  const mockOrgId = 'local'
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

      const result = await mcpService.createMcpServer(mockUserId, input)

      expect(result).toBeDefined()
      expect(result.name).toBe('Test MCP Server')
      expect(mockMcpRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test MCP Server',
          createdBy: mockUserId,
        })
      )
    })

    it('should throw error when server limit exceeded', async () => {
      mockMcpRepository.countByOrg.mockResolvedValue(20)

      await expect(
        mcpService.createMcpServer(mockUserId, {
          name: 'New Server',
          endpoint: 'http://localhost:3000',
          transport: 'streamable_http',
        })
      ).rejects.toThrow()
    })
  })

  describe('getMcpServer', () => {
    it('should return server when found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(mockServerRow)

      const result = await mcpService.getMcpServer(mockServerId)

      expect(result).toBeDefined()
      expect(result.id).toBe(mockServerId)
      expect(result.name).toBe('Test MCP Server')
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(mcpService.getMcpServer('non-existent')).rejects.toThrow()
    })
  })

  describe('listMcpServers', () => {
    it('should return paginated servers list', async () => {
      mockMcpRepository.findAll.mockResolvedValue({
        data: [mockServerRow],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      })

      const result = await mcpService.listMcpServers({ page: 1, limit: 20 })

      expect(result.data).toHaveLength(1)
      expect(result.meta.total).toBe(1)
      expect(mockMcpRepository.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
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

      await mcpService.listMcpServers({ status: 'connected' })

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

      const result = await mcpService.updateMcpServer(mockServerId, {
        name: 'Updated Server',
      })

      expect(result.name).toBe('Updated Server')
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
        expect.objectContaining({ name: 'Updated Server' })
      )
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.update.mockResolvedValue(null)

      await expect(
        mcpService.updateMcpServer('non-existent', { name: 'Updated' })
      ).rejects.toThrow()
    })
  })

  describe('deleteMcpServer', () => {
    it('should delete server successfully', async () => {
      mockMcpRepository.softDelete.mockResolvedValue(true)

      await expect(mcpService.deleteMcpServer(mockServerId)).resolves.not.toThrow()

      expect(mockMcpRepository.softDelete).toHaveBeenCalledWith(mockServerId)
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.softDelete.mockResolvedValue(false)

      await expect(mcpService.deleteMcpServer('non-existent')).rejects.toThrow()
    })
  })

  describe('testConnection', () => {
    it('should update status to connecting when testing', async () => {
      const httpServerRow = {
        ...mockServerRow,
        transport: 'streamable_http' as const,
        endpoint: 'http://invalid-server-12345.example.com/mcp',
      }
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(httpServerRow)
      mockMcpRepository.update.mockResolvedValue({
        ...httpServerRow,
        status: 'connecting',
      })

      // 连接会失败，但应该先把状态设置为 connecting
      try {
        await mcpService.testConnection(mockServerId)
      } catch {
        // 预期连接失败，但应该已经更新了状态
      }

      // 验证调用了 update 来设置 connecting 状态
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
        expect.objectContaining({ status: 'connecting' })
      )
    })

    it('should throw error when server not found', async () => {
      mockMcpRepository.findByIdAndOrg.mockResolvedValue(null)

      await expect(mcpService.testConnection('non-existent')).rejects.toThrow()
    })

    it('should update status to error on connection failure', async () => {
      const httpServerRow = {
        ...mockServerRow,
        transport: 'streamable_http' as const,
        endpoint: 'http://invalid-server-12345.example.com/mcp',
      }

      mockMcpRepository.findByIdAndOrg.mockResolvedValue(httpServerRow)
      mockMcpRepository.update.mockResolvedValue({
        ...httpServerRow,
        status: 'error',
      })

      // HTTP 连接到无效服务器应该失败
      await expect(mcpService.testConnection(mockServerId)).rejects.toThrow()

      // 验证调用了 update 来设置 error 状态
      expect(mockMcpRepository.update).toHaveBeenCalledWith(
        mockServerId,
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
        mcpService.syncToolsAndResources('non-existent', [], [])
      ).rejects.toThrow()
    })
  })
})
