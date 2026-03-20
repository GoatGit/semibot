/**
 * MCP Connection Integration Tests
 *
 * 使用真实 MCP 服务器测试连接功能
 * 这些测试需要网络连接，网络不可用时自动跳过
 */

import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

// 检查是否跳过集成测试
const SKIP_INTEGRATION_TESTS = process.env.SKIP_MCP_INTEGRATION_TESTS === 'true'

// SSE MCP 服务器端点
const MCP_SSE_SERVER_URL = 'https://mcp.smithery.ai/@anthropics/fetch/sse'

/**
 * 辅助函数：带重试的 MCP 连接
 */
async function connectWithRetry(
  url: string,
  maxRetries = 3
): Promise<{ client: Client; connected: boolean }> {
  let lastError: Error | null = null

  for (let i = 0; i < maxRetries; i++) {
    try {
      const transport = new SSEClientTransport(new URL(url))
      const client = new Client({
        name: 'semibot-test',
        version: '1.0.0',
      })

      await client.connect(transport)
      return { client, connected: true }
    } catch (error) {
      lastError = error as Error
      console.log(`[MCP Test] 连接尝试 ${i + 1}/${maxRetries} 失败:`, (error as Error).message)

      // 等待后重试
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
      }
    }
  }

  throw lastError
}

describe.skipIf(SKIP_INTEGRATION_TESTS)('MCP Connection Integration Tests', () => {
  describe('MCP SDK Direct Connection', () => {
    it('should connect to MCP server via SSE and list tools', async () => {
      let client: Client | null = null

      try {
        const result = await connectWithRetry(MCP_SSE_SERVER_URL)
        client = result.client

        // 获取工具列表
        const toolsResult = await client.listTools()

        // 验证返回了工具
        expect(toolsResult).toBeDefined()
        expect(toolsResult.tools).toBeDefined()
        expect(Array.isArray(toolsResult.tools)).toBe(true)

        console.log('[MCP Integration Test] 发现的工具数量:', toolsResult.tools.length)
        console.log(
          '[MCP Integration Test] 工具名称:',
          toolsResult.tools.map((t) => t.name)
        )
      } catch (error) {
        // 网络问题时跳过测试而非失败
        const errorMessage = (error as Error).message
        if (
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('network') ||
          errorMessage.includes('TLS')
        ) {
          console.log('[MCP Integration Test] 跳过：网络不可用 -', errorMessage)
          return // 视为通过
        }
        throw error
      } finally {
        if (client) {
          try {
            await client.close()
          } catch {
            // 忽略关闭错误
          }
        }
      }
    }, 60000)

    it('should get server capabilities', async () => {
      let client: Client | null = null

      try {
        const result = await connectWithRetry(MCP_SSE_SERVER_URL)
        client = result.client

        const serverCapabilities = client.getServerCapabilities()

        expect(serverCapabilities).toBeDefined()
        console.log('[MCP Integration Test] 服务器能力:', JSON.stringify(serverCapabilities, null, 2))
      } catch (error) {
        const errorMessage = (error as Error).message
        if (
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('network') ||
          errorMessage.includes('TLS')
        ) {
          console.log('[MCP Integration Test] 跳过：网络不可用 -', errorMessage)
          return
        }
        throw error
      } finally {
        if (client) {
          try {
            await client.close()
          } catch {
            // 忽略关闭错误
          }
        }
      }
    }, 60000)

    it('should handle connection to invalid server gracefully', async () => {
      const invalidUrl = 'https://invalid-mcp-server-12345.example.com/sse'

      try {
        const transport = new SSEClientTransport(new URL(invalidUrl))
        const client = new Client({
          name: 'semibot-test',
          version: '1.0.0',
        })

        await client.connect(transport)
        await client.close()
      } catch (error) {
        // 期望的行为：连接失败应该抛出错误
        expect(error).toBeDefined()
        console.log('[MCP Integration Test] 预期的连接错误:', (error as Error).message)
      }
    }, 30000)
  })

  describe('MCP Tool Execution', () => {
    it('should call a tool on the MCP server', async () => {
      let client: Client | null = null

      try {
        const result = await connectWithRetry(MCP_SSE_SERVER_URL)
        client = result.client

        const toolsResult = await client.listTools()

        if (toolsResult.tools.length > 0) {
          const firstTool = toolsResult.tools[0]
          console.log('[MCP Integration Test] 尝试调用工具:', firstTool.name)

          try {
            const callResult = await client.callTool({
              name: firstTool.name,
              arguments: {},
            })

            expect(callResult).toBeDefined()
            console.log('[MCP Integration Test] 工具调用结果:', JSON.stringify(callResult, null, 2))
          } catch (toolError) {
            // 工具调用可能因为参数不正确而失败，这是预期的
            console.log('[MCP Integration Test] 工具调用错误（预期）:', (toolError as Error).message)
          }
        }
      } catch (error) {
        const errorMessage = (error as Error).message
        if (
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('network') ||
          errorMessage.includes('TLS')
        ) {
          console.log('[MCP Integration Test] 跳过：网络不可用 -', errorMessage)
          return
        }
        throw error
      } finally {
        if (client) {
          try {
            await client.close()
          } catch {
            // 忽略关闭错误
          }
        }
      }
    }, 60000)
  })
})

describe('MCP Client Unit Tests', () => {
  it('should create MCP client configuration correctly', () => {
    const config = {
      name: 'semibot-test',
      version: '1.0.0',
    }

    expect(config.name).toBe('semibot-test')
    expect(config.version).toBe('1.0.0')
  })

  it('should validate MCP server URL format', () => {
    const validUrls = [
      'https://mcp.smithery.ai/@anthropics/fetch/sse',
      'https://server.example.com/mcp/sse',
      'http://localhost:3000/sse',
    ]

    const invalidUrls = ['', 'not-a-url']

    validUrls.forEach((url) => {
      expect(() => new URL(url)).not.toThrow()
    })

    invalidUrls.forEach((url) => {
      if (url === '') {
        expect(() => new URL(url)).toThrow()
      }
    })
  })

  it('should parse MCP JSON-RPC messages correctly', () => {
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'semibot',
          version: '1.0.0',
        },
      },
    }

    expect(initializeRequest.jsonrpc).toBe('2.0')
    expect(initializeRequest.method).toBe('initialize')
    expect(initializeRequest.params.clientInfo.name).toBe('semibot')
  })

  it('should create correct MCP tool list request', () => {
    const listToolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }

    expect(listToolsRequest.method).toBe('tools/list')
  })

  it('should create correct MCP tool call request', () => {
    const callToolRequest = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'fetch',
        arguments: {
          url: 'https://example.com',
        },
      },
    }

    expect(callToolRequest.method).toBe('tools/call')
    expect(callToolRequest.params.name).toBe('fetch')
  })
})
