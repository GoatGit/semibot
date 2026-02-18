# PRD: 进化系统补全（Redis 冷却期 + 技能提升）

## 背景

EVOLUTION.md 设计了完整的进化流程，当前有两处关键 TODO 未完成：

1. `evolution/engine.py:296` — Redis 冷却期时间戳获取未实现
2. `evolution/engine.py:301` — Redis 频率计数未实现
3. `evolved-skill.service.ts:127` — 进化技能提升为正式技能的转换逻辑未实现

这导致进化频率无法控制（可能过度进化），且进化出的技能无法真正进入正式技能库被复用。

## 功能需求

### 1. Redis 冷却期机制

- 每个 Agent 每小时最多触发 5 次进化（EVOLUTION.md 规定）
- 使用 Redis ZSET 记录进化时间戳
- 冷却期检查必须是原子操作（Pipeline 或 Lua 脚本）

### 2. 进化技能提升（Promote）

- 审核通过的进化技能可提升为正式技能
- 提升时写入 `skills` 表，`source_type = 'evolved'`
- 保留原始 `evolved_skill_id` 关联
- 提升后更新进化技能状态为 `promoted`
- 自动创建对应的 `skill_definitions` 记录

## 技术方案

### Redis 冷却期

```python
# Lua 脚本：原子性检查并记录进化
EVOLUTION_COOLDOWN_SCRIPT = """
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max_count = tonumber(ARGV[3])

-- 清理窗口外的记录
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- 检查当前窗口内的次数
local count = redis.call('ZCARD', key)
if count >= max_count then
    return 0  -- 冷却中，拒绝
end

-- 记录本次进化
redis.call('ZADD', key, now, ARGV[4])
redis.call('EXPIRE', key, window)
return 1  -- 允许
"""
```

### Promote 流程

```typescript
// evolved-skill.service.ts
async promote(id: string, orgId: string, userId: string) {
  const evolvedSkill = await this.evolvedSkillRepo.findByIdAndOrg(id, orgId);
  // 1. 创建正式技能
  const skill = await this.skillRepo.create({
    orgId, name: evolvedSkill.name,
    description: evolvedSkill.description,
    sourceType: 'evolved', sourceId: evolvedSkill.id,
    config: evolvedSkill.config, createdBy: userId,
  });
  // 2. 更新进化技能状态
  await this.evolvedSkillRepo.update(id, { status: 'promoted', promotedSkillId: skill.id });
  return skill;
}
```

### 涉及文件

- 修改 `runtime/src/evolution/engine.py` — 实现 Redis 冷却期
- 修改 `apps/api/src/services/evolved-skill.service.ts` — 实现 promote 逻辑
- 修改 `apps/api/src/repositories/evolved-skill.repository.ts` — 新增 promotedSkillId 字段

## 优先级

**P0 — 进化系统的核心闭环，不完成则进化功能不可用**

## 验收标准

- [ ] Redis 冷却期检查正常（每 Agent 每小时最多 5 次）
- [ ] 冷却期使用原子操作，无竞态
- [ ] Promote 正确写入 skills 表
- [ ] Promote 后进化技能状态更新为 promoted
- [ ] 原始关联关系保留
- [ ] 单元测试覆盖
