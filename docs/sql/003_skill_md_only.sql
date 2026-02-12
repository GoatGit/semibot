-- ============================================================
-- Migration: 全面切换到 SKILL.md 模式
-- 移除 version、manifest 相关字段，统一为 SKILL.md 单一流程
-- ============================================================

-- Step 1: 移除 skill_definitions 表的 current_version 字段
ALTER TABLE skill_definitions
  DROP COLUMN IF EXISTS current_version;

-- Step 2: 移除 skill_packages 表的 legacy 字段
ALTER TABLE skill_packages
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS manifest_url,
  DROP COLUMN IF EXISTS manifest_content,
  DROP COLUMN IF EXISTS source_ref,
  DROP COLUMN IF EXISTS deprecated_at,
  DROP COLUMN IF EXISTS deprecated_reason;

-- Step 3: 确保 uq_skill_packages_definition 唯一约束存在
-- （一个 skill_definition 只保留一个 package）
ALTER TABLE skill_packages
  DROP CONSTRAINT IF EXISTS uq_skill_packages_version;

ALTER TABLE skill_packages
  DROP CONSTRAINT IF EXISTS uq_skill_packages_definition;

ALTER TABLE skill_packages
  ADD CONSTRAINT uq_skill_packages_definition UNIQUE (skill_definition_id);

-- Step 4: 移除不再需要的索引
DROP INDEX IF EXISTS idx_skill_packages_version;

-- Step 5: 移除 agent_skills 表的版本锁定字段
ALTER TABLE agent_skills
  DROP COLUMN IF EXISTS version_lock,
  DROP COLUMN IF EXISTS auto_update;

-- Step 6: 更新注释
COMMENT ON TABLE skill_packages IS '技能包表，每个 skill_definition 对应一个 package，元数据来自 SKILL.md';
COMMENT ON TABLE skill_definitions IS '技能定义表，管理员统一管理，全租户可见，无版本控制';
