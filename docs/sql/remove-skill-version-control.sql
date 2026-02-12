-- ============================================================
-- 取消 Skill 版本控制，每次安装覆盖旧包
-- ============================================================

-- Step 1: 清理同一 definition 的重复 package（保留最新的一条）
DELETE FROM skill_packages
WHERE id NOT IN (
  SELECT DISTINCT ON (skill_definition_id) id
  FROM skill_packages
  ORDER BY skill_definition_id, created_at DESC
);

-- Step 2: ��除旧的版本唯一约束（如果存在）
ALTER TABLE skill_packages
  DROP CONSTRAINT IF EXISTS uq_skill_packages_version;

-- Step 3: 添加新的唯一约束（一个 skill 只有一个 package）
ALTER TABLE skill_packages
  DROP CONSTRAINT IF EXISTS uq_skill_packages_definition;

ALTER TABLE skill_packages
  ADD CONSTRAINT uq_skill_packages_definition UNIQUE (skill_definition_id);
