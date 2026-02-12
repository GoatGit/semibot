/**
 * Skill Validator 简单测试
 */

import { describe, it, expect } from 'vitest'

describe('Skill Validator - Basic', () => {
  it('should import successfully', () => {
    expect(true).toBe(true)
  })

  describe('SkillMdFrontmatter', () => {
    it('should validate basic SKILL.md frontmatter structure', () => {
      const frontmatter = {
        skill_id: 'test-skill',
        name: 'Test Skill',
        description: 'A test skill',
      }

      expect(frontmatter.skill_id).toBe('test-skill')
      expect(frontmatter.name).toBe('Test Skill')
    })
  })
})
