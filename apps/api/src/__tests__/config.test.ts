/**
 * LLM 配置单元测试
 */
import { describe, it, expect, vi } from 'vitest'
import {
  getLLMConfig,
  getConfiguredLLMProviders,
  OPENAI_API_KEY,
  OPENAI_API_BASE_URL,
  ANTHROPIC_API_KEY,
  ANTHROPIC_API_BASE_URL,
  GOOGLE_AI_API_KEY,
  GOOGLE_AI_API_BASE_URL,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_API_BASE_URL,
  AZURE_OPENAI_API_VERSION,
  CUSTOM_LLM_API_KEY,
  CUSTOM_LLM_API_BASE_URL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_MODEL_NAME,
} from '../constants/config'

describe('LLM Configuration', () => {
  describe('Default Values', () => {
    it('should have default OpenAI base URL', () => {
      expect(OPENAI_API_BASE_URL).toBe('https://api.openai.com/v1')
    })

    it('should have default Anthropic base URL', () => {
      expect(ANTHROPIC_API_BASE_URL).toBe('https://api.anthropic.com')
    })

    it('should have default Google AI base URL', () => {
      expect(GOOGLE_AI_API_BASE_URL).toBe('https://generativelanguage.googleapis.com')
    })

    it('should have default Azure API version', () => {
      expect(AZURE_OPENAI_API_VERSION).toBe('2024-02-15-preview')
    })

    it('should have default LLM provider', () => {
      expect(DEFAULT_LLM_PROVIDER).toBe('openai')
    })

    it('should have default model name', () => {
      expect(DEFAULT_MODEL_NAME).toBe('gpt-4o')
    })
  })

  describe('getLLMConfig', () => {
    it('should return null for unconfigured provider', () => {
      const config = getLLMConfig('nonexistent')
      expect(config).toBeNull()
    })

    it('should return OpenAI config when API key is set', async () => {
      // 模拟环境变量
      const originalKey = process.env.OPENAI_API_KEY
      process.env.OPENAI_API_KEY = 'test-key'

      // 重新导入模块以应用新环境变量
      vi.resetModules()
      const { getLLMConfig: getConfig } = await import('../constants/config')

      const config = getConfig('openai')
      if (process.env.OPENAI_API_KEY) {
        expect(config).not.toBeNull()
        expect(config?.baseUrl).toBe('https://api.openai.com/v1')
      }

      // 恢复环境变量
      process.env.OPENAI_API_KEY = originalKey
    })

    it('should return null for OpenAI when API key is empty', () => {
      if (!OPENAI_API_KEY) {
        const config = getLLMConfig('openai')
        expect(config).toBeNull()
      }
    })

    it('should return null for Anthropic when API key is empty', () => {
      if (!ANTHROPIC_API_KEY) {
        const config = getLLMConfig('anthropic')
        expect(config).toBeNull()
      }
    })

    it('should return null for Google when API key is empty', () => {
      if (!GOOGLE_AI_API_KEY) {
        const config = getLLMConfig('google')
        expect(config).toBeNull()
      }
    })

    it('should return null for Azure when credentials are incomplete', () => {
      if (!AZURE_OPENAI_API_KEY || !AZURE_OPENAI_API_BASE_URL) {
        const config = getLLMConfig('azure')
        expect(config).toBeNull()
      }
    })

    it('should return null for custom when credentials are incomplete', () => {
      if (!CUSTOM_LLM_API_KEY || !CUSTOM_LLM_API_BASE_URL) {
        const config = getLLMConfig('custom')
        expect(config).toBeNull()
      }
    })
  })

  describe('getConfiguredLLMProviders', () => {
    it('should return an array', () => {
      const providers = getConfiguredLLMProviders()
      expect(Array.isArray(providers)).toBe(true)
    })

    it('should only include providers with valid API keys', () => {
      const providers = getConfiguredLLMProviders()

      // 如果 OpenAI key 为空，不应该包含 openai
      if (!OPENAI_API_KEY) {
        expect(providers).not.toContain('openai')
      }

      // 如果 Anthropic key 为空，不应该包含 anthropic
      if (!ANTHROPIC_API_KEY) {
        expect(providers).not.toContain('anthropic')
      }

      // 如果 Google key 为空，不应该包含 google
      if (!GOOGLE_AI_API_KEY) {
        expect(providers).not.toContain('google')
      }
    })
  })

  describe('LLMProviderConfig interface', () => {
    it('should have required fields for OpenAI config', () => {
      if (OPENAI_API_KEY) {
        const config = getLLMConfig('openai')
        expect(config).toHaveProperty('apiKey')
        expect(config).toHaveProperty('baseUrl')
      }
    })

    it('should include optional orgId for OpenAI', () => {
      if (OPENAI_API_KEY) {
        const config = getLLMConfig('openai')
        // orgId 是可选的
        expect(config?.orgId === undefined || typeof config?.orgId === 'string').toBe(true)
      }
    })

    it('should include apiVersion for Azure config', () => {
      if (AZURE_OPENAI_API_KEY && AZURE_OPENAI_API_BASE_URL) {
        const config = getLLMConfig('azure')
        expect(config).toHaveProperty('apiVersion')
      }
    })
  })
})
