# TASK-58: 进化系统补全 — Redis 冷却期 + 技能提升闭环

## 优先级: P0 — 进化系统核心闭环

## PRD

[进化系统补全](../PRDS/missing-evolution-redis-promote.md)

## 描述

进化系统有两处关键 TODO 未完成：Redis 冷却期检查（engine.py:296/301）和进化技能提升为正式技能的转换逻辑（evolved-skill.service.ts:127）。不完成则进化功能无法形成闭环。

## 涉及文件

- `runtime/src/evolution/engine.py`
  - `_check_cooldown()` 方法 — 行 290-310，实现 Redis ZSET 冷却期
- `apps/api/src/services/evolved-skill.service.ts`
  - `promote()` 方法 — 行 120-135，实现写入 skills 表
- `apps/api/src/repositories/evolved-skill.repository.ts`
  - 新增 `promotedSkillId` 字段更新

## 修复方式

### 1. Redis 冷却期（Lua 脚本原子操作）

```python
EVOLUTION_COOLDOWN_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_count = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= max_count then
    return 0
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('EXPIRE', key, window)
return 1
"""
```

### 2. Promote 逻辑

```typescript
async promote(id: string, orgId: string, userId: string) {
  const evolvedSkill = await this.evolvedSkillRepo.findByIdAndOrg(id, orgId);
  const skill = await this.skillRepo.create({
    orgId, name: evolvedSkill.name,
    sourceType: 'evolved', sourceId: evolvedSkill.id,
    config: evolvedSkill.config, createdBy: userId,
  });
  await this.evolvedSkillRepo.update(id, { status: 'promoted', promotedSkillId: skill.id });
  return skill;
}
```

## 验收标准

- [ ] Redis 冷却期检查正常（每 Agent 每小时最多 5 次）
- [ ] 冷却期使用 Lua 脚本原子操作
- [ ] Promote 正确写入 skills 表
- [ ] Promote 后进化技能状态更新为 promoted
- [ ] 单元测试覆盖

## 状态: 待处理
