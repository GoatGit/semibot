# 任务：Tool/Skill org_id 验证

**优先级**: 🟢 P2 - 中优先级
**类型**: 安全规范
**预估工时**: 1-2 小时
**影响范围**: tool.repository.ts, skill.repository.ts

---

## 问题描述

Tool 和 Skill 的部分查询方法缺少 `org_id` 验证，存在跨租户数据泄露风险。

---

## 违规位置

### tool.repository.ts

```typescript
// ❌ 缺少 org_id 验证
export async function findById(id: string): Promise<ToolRow | null> {
  const result = await sql`
    SELECT * FROM tools
    WHERE id = ${id}
    AND deleted_at IS NULL
  `
  return result[0] || null
}
```

### skill.repository.ts

```typescript
// ❌ 缺少 org_id 验证
export async function findByDefinitionId(definitionId: string): Promise<SkillRow[]> {
  const result = await sql`
    SELECT * FROM skills
    WHERE definition_id = ${definitionId}
    AND deleted_at IS NULL
  `
  return result as SkillRow[]
}
```

---

## 修复方案

### 1. Tool Repository

```typescript
// apps/api/src/repositories/tool.repository.ts

/**
 * 根据 ID 和组织查询 Tool（含租户隔离）
 * @param id Tool ID
 * @param orgId 组织 ID
 */
export async function findByIdAndOrg(
  id: string,
  orgId: string
): Promise<ToolRow | null> {
  const result = await sql`
    SELECT * FROM tools
    WHERE id = ${id}
    AND org_id = ${orgId}
    AND deleted_at IS NULL
  `
  return result[0] || null
}

/**
 * 根据 ID 查询 Tool（仅内部使用，需谨慎）
 * @internal
 */
export async function findById(id: string): Promise<ToolRow | null> {
  logger.warn('[ToolRepository] findById 被调用，请确认是否需要租户隔离', { id })

  const result = await sql`
    SELECT * FROM tools
    WHERE id = ${id}
    AND deleted_at IS NULL
  `
  return result[0] || null
}

/**
 * 根据组织查询 Tool 列表
 */
export async function findByOrg(options: {
  orgId: string
  page?: number
  limit?: number
  search?: string
}): Promise<{ data: ToolRow[]; meta: PaginationMeta }> {
  const { orgId, page = 1, limit = 20, search } = options

  // 确保 orgId 存在
  if (!orgId) {
    logger.error('[ToolRepository] findByOrg 缺少 orgId')
    throw new Error('orgId is required')
  }

  const conditions = [
    sql`org_id = ${orgId}`,
    sql`deleted_at IS NULL`
  ]

  if (search) {
    conditions.push(sql`name ILIKE ${'%' + search + '%'}`)
  }

  // ... 分页查询
}
```

### 2. Skill Repository

```typescript
// apps/api/src/repositories/skill.repository.ts

/**
 * 根据 ID 和组织查询 Skill
 */
export async function findByIdAndOrg(
  id: string,
  orgId: string
): Promise<SkillRow | null> {
  const result = await sql`
    SELECT * FROM skills
    WHERE id = ${id}
    AND (org_id = ${orgId} OR is_builtin = true)
    AND deleted_at IS NULL
  `
  return result[0] || null
}

/**
 * 根据 Definition ID 和组织查询 Skills
 */
export async function findByDefinitionIdAndOrg(
  definitionId: string,
  orgId: string
): Promise<SkillRow[]> {
  const result = await sql`
    SELECT * FROM skills
    WHERE definition_id = ${definitionId}
    AND (org_id = ${orgId} OR is_builtin = true)
    AND deleted_at IS NULL
  `
  return result as SkillRow[]
}

/**
 * 批量查询活跃的 Skills（含租户隔离）
 */
export async function findActiveByIdsAndOrg(
  ids: string[],
  orgId: string
): Promise<SkillRow[]> {
  if (ids.length === 0) return []

  const result = await sql`
    SELECT * FROM skills
    WHERE id = ANY(${ids})
    AND is_active = true
    AND (org_id = ${orgId} OR is_builtin = true)
    AND deleted_at IS NULL
  `
  return result as SkillRow[]
}
```

### 3. Service 层调用更新

```typescript
// apps/api/src/services/tool.service.ts

export async function getToolById(
  toolId: string,
  orgId: string  // ✅ 必须传入 orgId
): Promise<Tool> {
  const tool = await toolRepository.findByIdAndOrg(toolId, orgId)

  if (!tool) {
    throw errors.notFound('Tool')
  }

  return rowToTool(tool)
}
```

---

## 测试验证

```typescript
describe('多租户隔离测试', () => {
  let orgA: string
  let orgB: string

  beforeAll(async () => {
    orgA = await createTestOrg('Org A')
    orgB = await createTestOrg('Org B')
  })

  describe('Tool 隔离', () => {
    it('组织 A 不能访问组织 B 的 Tool', async () => {
      const toolB = await toolRepository.create({
        orgId: orgB,
        name: 'Tool B',
        createdBy: userB
      })

      const result = await toolRepository.findByIdAndOrg(toolB.id, orgA)

      expect(result).toBeNull()
    })
  })

  describe('Skill 隔离', () => {
    it('组织 A 不能访问组织 B 的 Skill', async () => {
      const skillB = await skillRepository.create({
        orgId: orgB,
        name: 'Skill B',
        createdBy: userB
      })

      const result = await skillRepository.findByIdAndOrg(skillB.id, orgA)

      expect(result).toBeNull()
    })

    it('内置 Skill 所有组织都可访问', async () => {
      const builtinSkill = await skillRepository.create({
        orgId: 'system',
        name: 'Builtin Skill',
        isBuiltin: true,
        createdBy: 'system'
      })

      const resultA = await skillRepository.findByIdAndOrg(builtinSkill.id, orgA)
      const resultB = await skillRepository.findByIdAndOrg(builtinSkill.id, orgB)

      expect(resultA).not.toBeNull()
      expect(resultB).not.toBeNull()
    })
  })
})
```

---

## 修复清单

### Repository 层
- [ ] `tool.repository.ts` - 添加 `findByIdAndOrg`
- [ ] `tool.repository.ts` - 修改现有方法添加 orgId 参数
- [ ] `skill.repository.ts` - 添加 `findByIdAndOrg`
- [ ] `skill.repository.ts` - 修改 `findByDefinitionId` 添加 orgId

### Service 层
- [ ] `tool.service.ts` - 使用带 orgId 的方法
- [ ] `skill.service.ts` - 使用带 orgId 的方法

### 测试
- [ ] 添加多租户隔离测试

---

## 完成标准

- [ ] 所有查询方法包含 org_id 验证
- [ ] 内置资源（is_builtin）正确处理
- [ ] 多租户隔离测试通过
- [ ] 代码审查通过

---

## 相关文档

- [安全规范 - 多租户隔离](.claude/rules/security.md#多租户隔离)
