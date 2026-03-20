/**
 * ComponentRegistry 测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ComponentRegistry, getComponent, registerComponent } from '@/components/agent2ui/ComponentRegistry'
import type { Agent2UIType } from '@/types'

// 创建一个简单的 mock 组件
const MockComponent = () => null

describe('ComponentRegistry', () => {
  beforeEach(() => {
    // 每次测试前重置注册表
    ComponentRegistry.reset()
  })

  describe('get', () => {
    it('应该返回已注册的组件', () => {
      const component = ComponentRegistry.get('text')
      expect(component).toBeDefined()
    })

    it('应该返回 undefined 对于未注册的类型', () => {
      const component = ComponentRegistry.get('nonexistent' as Agent2UIType)
      expect(component).toBeUndefined()
    })
  })

  describe('register', () => {
    it('应该注册新组件', () => {
      const customType = 'custom_type' as Agent2UIType
      ComponentRegistry.register(customType, MockComponent)

      expect(ComponentRegistry.get(customType)).toBe(MockComponent)
    })

    it('应该覆盖已存在的组件', () => {
      const originalComponent = ComponentRegistry.get('text')
      ComponentRegistry.register('text', MockComponent)

      expect(ComponentRegistry.get('text')).toBe(MockComponent)
      expect(ComponentRegistry.get('text')).not.toBe(originalComponent)
    })
  })

  describe('registerAll', () => {
    it('应该批量注册组件', () => {
      const CustomComponent1 = () => null
      const CustomComponent2 = () => null

      ComponentRegistry.registerAll({
        text: CustomComponent1,
        markdown: CustomComponent2,
      })

      expect(ComponentRegistry.get('text')).toBe(CustomComponent1)
      expect(ComponentRegistry.get('markdown')).toBe(CustomComponent2)
    })

    it('应该忽略 undefined 值', () => {
      const originalTextComponent = ComponentRegistry.get('text')

      ComponentRegistry.registerAll({
        text: undefined as unknown as undefined,
      })

      expect(ComponentRegistry.get('text')).toBe(originalTextComponent)
    })
  })

  describe('has', () => {
    it('应该返回 true 对于已注册的类型', () => {
      expect(ComponentRegistry.has('text')).toBe(true)
      expect(ComponentRegistry.has('markdown')).toBe(true)
      expect(ComponentRegistry.has('code')).toBe(true)
    })

    it('应该返回 false 对于未注册的类型', () => {
      expect(ComponentRegistry.has('nonexistent' as Agent2UIType)).toBe(false)
    })
  })

  describe('getRegisteredTypes', () => {
    it('应该返回所有已注册的类型', () => {
      const types = ComponentRegistry.getRegisteredTypes()

      expect(types).toContain('text')
      expect(types).toContain('markdown')
      expect(types).toContain('code')
      expect(types).toContain('table')
      expect(types).toContain('chart')
      expect(types).toContain('tool_call')
      expect(types).toContain('thinking')
      expect(types).toContain('error')
    })

    it('应该包含所有默认组件类型', () => {
      const types = ComponentRegistry.getRegisteredTypes()

      // 验证默认组件映射中的所有类型都已注册
      const expectedTypes: Agent2UIType[] = [
        'text',
        'markdown',
        'code',
        'table',
        'chart',
        'image',
        'file',
        'plan',
        'progress',
        'tool_call',
        'tool_result',
        'skill_call',
        'skill_result',
        'mcp_call',
        'mcp_result',
        'plan_step',
        'error',
        'thinking',
        'report',
        'sandbox_log',
        'sandbox_output',
        'sandbox_status',
      ]

      expectedTypes.forEach((type) => {
        expect(types).toContain(type)
      })
    })
  })

  describe('reset', () => {
    it('应该重置为默认组件映射', () => {
      // 注册自定义组件
      ComponentRegistry.register('text', MockComponent)
      expect(ComponentRegistry.get('text')).toBe(MockComponent)

      // 重置
      ComponentRegistry.reset()

      // 应该恢复默认组件
      expect(ComponentRegistry.get('text')).not.toBe(MockComponent)
      expect(ComponentRegistry.get('text')).toBeDefined()
    })
  })

  describe('快捷方法', () => {
    it('getComponent 应该调用 ComponentRegistry.get', () => {
      const component = getComponent('text')
      expect(component).toBe(ComponentRegistry.get('text'))
    })

    it('registerComponent 应该调用 ComponentRegistry.register', () => {
      const customType = 'custom' as Agent2UIType
      registerComponent(customType, MockComponent)

      expect(ComponentRegistry.get(customType)).toBe(MockComponent)
    })
  })
})
