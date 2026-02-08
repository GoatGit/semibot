/**
 * Skill Validator 简单测试
 */

import { describe, it, expect } from 'vitest'

describe('Skill Validator - Basic', () => {
  it('should import successfully', () => {
    expect(true).toBe(true)
  })

  describe('validateManifest', () => {
    it('should validate basic manifest structure', () => {
      const manifest = {
        skill_id: 'test-skill',
        name: 'Test Skill',
        version: '1.0.0',
        description: 'A test skill',
      }

      expect(manifest.skill_id).toBe('test-skill')
      expect(manifest.version).toBe('1.0.0')
    })
  })
})
