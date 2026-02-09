-- ============================================================================
-- Skills 管理与使用规范 - 数据模型升级
-- 版本: 2.0
-- 创建时间: 2026-02-09
-- 说明: 引入 SkillDefinition 和 SkillPackage 两层模型
-- ============================================================================

-- ============================================================================
-- 1. skill_definitions - 平台级技能定义表（管理员管理，全租户可见）
-- ============================================================================
CREATE TABLE skill_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 技能定义唯一标识
    skill_id VARCHAR(120) NOT NULL UNIQUE,                          -- 技能标识符（如 text-editor, code-analyzer）
    name VARCHAR(100) NOT NULL,                                     -- 技能名称
    description TEXT,                                               -- 技能描述
    trigger_keywords TEXT[] DEFAULT '{}',                           -- 触发关键词
    category VARCHAR(50),                                           -- 技能分类（如 productivity, development, data）
    tags TEXT[] DEFAULT '{}',                                       -- 标签
    icon_url TEXT,                                                  -- 图标 URL
    author VARCHAR(100),                                            -- 作者
    homepage_url TEXT,                                              -- 主页 URL
    documentation_url TEXT,                                         -- 文档 URL
    current_version VARCHAR(50),                                    -- 当前激活版本
    is_active BOOLEAN DEFAULT true,                                 -- 是否启用
    is_public BOOLEAN DEFAULT true,                                 -- 是否公开（全租户可见）
    created_by UUID,                                                -- 创建者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW()                            -- 更新时间
);

-- 索引
CREATE INDEX idx_skill_definitions_skill_id ON skill_definitions(skill_id);
CREATE INDEX idx_skill_definitions_active ON skill_definitions(is_active) WHERE is_active = true;
CREATE INDEX idx_skill_definitions_public ON skill_definitions(is_public) WHERE is_public = true;
CREATE INDEX idx_skill_definitions_category ON skill_definitions(category);

-- 更新触发器
CREATE TRIGGER skill_definitions_updated_at
    BEFORE UPDATE ON skill_definitions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE skill_definitions IS '技能定义表，管理员统一管理，全租户可见';
COMMENT ON COLUMN skill_definitions.id IS '技能定义唯一标识';
COMMENT ON COLUMN skill_definitions.skill_id IS '技能标识符，全局唯一（如 text-editor）';
COMMENT ON COLUMN skill_definitions.name IS '技能名称';
COMMENT ON COLUMN skill_definitions.description IS '技能描述';
COMMENT ON COLUMN skill_definitions.trigger_keywords IS '触发关键词数组';
COMMENT ON COLUMN skill_definitions.category IS '技能分类';
COMMENT ON COLUMN skill_definitions.current_version IS '当前激活版本号';
COMMENT ON COLUMN skill_definitions.is_active IS '是否启用';
COMMENT ON COLUMN skill_definitions.is_public IS '是否公开（全租户可见）';

-- ============================================================================
-- 2. skill_packages - 可执行目录包表（按版本存储）
-- ============================================================================
CREATE TABLE skill_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 包记录唯一标识
    skill_definition_id UUID NOT NULL,                              -- 关联的技能定义（逻辑外键 -> skill_definitions.id）
    version VARCHAR(50) NOT NULL,                                   -- 版本号（如 1.0.0, 1.2.3-beta）
    source_type VARCHAR(20) NOT NULL,                               -- 来源类型（git/url/registry/local/anthropic）
    source_url TEXT,                                                -- 来源 URL
    source_ref TEXT,                                                -- 来源引用（git commit/tag/branch）
    manifest_url TEXT,                                              -- Manifest URL
    manifest_content JSONB,                                         -- Manifest 内容（完整 JSON）
    package_path TEXT NOT NULL,                                     -- 包存储路径（相对于 SKILLS_STORAGE_ROOT）
    checksum_sha256 VARCHAR(64) NOT NULL,                           -- SHA256 校验值
    file_size_bytes BIGINT,                                         -- 包文件大小（字节）
    status VARCHAR(20) NOT NULL DEFAULT 'pending',                  -- 状态（pending/downloading/validating/installing/active/failed/deprecated）
    validation_result JSONB,                                        -- 校验结果（目录结构、入口文件等）
    tools JSONB NOT NULL DEFAULT '[]',                              -- 工具配置列表
    config JSONB DEFAULT '{}',                                      -- 包配置
    installed_at TIMESTAMPTZ,                                       -- 安装完成时间
    installed_by UUID,                                              -- 安装者（逻辑外键 -> users.id）
    deprecated_at TIMESTAMPTZ,                                      -- 废弃时间
    deprecated_reason TEXT,                                         -- 废弃原因
    created_at TIMESTAMPTZ DEFAULT NOW(),                           -- 创建时间
    updated_at TIMESTAMPTZ DEFAULT NOW(),                           -- 更新时间

    -- 约束：同一技能定义下版本号唯一
    CONSTRAINT uq_skill_packages_version UNIQUE (skill_definition_id, version)
);

-- 索引
CREATE INDEX idx_skill_packages_definition ON skill_packages(skill_definition_id);
CREATE INDEX idx_skill_packages_version ON skill_packages(skill_definition_id, version);
CREATE INDEX idx_skill_packages_status ON skill_packages(status);
CREATE INDEX idx_skill_packages_active ON skill_packages(skill_definition_id, status) WHERE status = 'active';
CREATE INDEX idx_skill_packages_checksum ON skill_packages(checksum_sha256);

-- 更新��发器
CREATE TRIGGER skill_packages_updated_at
    BEFORE UPDATE ON skill_packages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

COMMENT ON TABLE skill_packages IS '技能包表，按版本存储可执行目录包';
COMMENT ON COLUMN skill_packages.id IS '包记录唯一标识';
COMMENT ON COLUMN skill_packages.skill_definition_id IS '关联的技能定义 ID';
COMMENT ON COLUMN skill_packages.version IS '版本号（语义化版本）';
COMMENT ON COLUMN skill_packages.source_type IS '来源类型（git/url/registry/local/anthropic）';
COMMENT ON COLUMN skill_packages.source_url IS '来源 URL';
COMMENT ON COLUMN skill_packages.package_path IS '包存储路径';
COMMENT ON COLUMN skill_packages.checksum_sha256 IS 'SHA256 校验值';
COMMENT ON COLUMN skill_packages.status IS '状态（pending/downloading/validating/installing/active/failed/deprecated）';
COMMENT ON COLUMN skill_packages.validation_result IS '校验结果 JSON';

-- ============================================================================
-- 3. skill_install_logs - 安装日志表
-- ============================================================================
CREATE TABLE skill_install_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),                  -- 日志记录唯一标识
    skill_package_id UUID NOT NULL,                                 -- 关联的包记录（逻辑外键 -> skill_packages.id）
    skill_definition_id UUID NOT NULL,                              -- 关联的技能定义（逻辑外键 -> skill_definitions.id）
    operation VARCHAR(20) NOT NULL,                                 -- 操作类型（install/update/rollback/uninstall）
    status VARCHAR(20) NOT NULL,                                    -- 状态（pending/running/success/failed）
    step VARCHAR(50),                                               -- 当前步骤（fetch_manifest/download/validate/install）
    progress INTEGER DEFAULT 0,                                     -- 进度百分比（0-100）
    message TEXT,                                                   -- 日志消息
    error_code VARCHAR(50),                                         -- 错误码
    error_message TEXT,                                             -- 错误详情
    error_stack TEXT,                                               -- 错误堆栈
    metadata JSONB DEFAULT '{}',                                    -- 元数据（如下载速度、文件数等）
    started_at TIMESTAMPTZ DEFAULT NOW(),                           -- 开始时间
    completed_at TIMESTAMPTZ,                                       -- 完成时间
    duration_ms INTEGER,                                            -- 耗时（毫秒）
    installed_by UUID,                                              -- 操作者（逻辑外键 -> users.id）
    created_at TIMESTAMPTZ DEFAULT NOW()                            -- 创建时间
);

-- 索引
CREATE INDEX idx_skill_install_logs_package ON skill_install_logs(skill_package_id);
CREATE INDEX idx_skill_install_logs_definition ON skill_install_logs(skill_definition_id);
CREATE INDEX idx_skill_install_logs_status ON skill_install_logs(status);
CREATE INDEX idx_skill_install_logs_operation ON skill_install_logs(operation);
CREATE INDEX idx_skill_install_logs_created ON skill_install_logs(created_at DESC);

COMMENT ON TABLE skill_install_logs IS '技能安装日志表，记录安装/更新/回滚操作';
COMMENT ON COLUMN skill_install_logs.id IS '日志记录唯一标识';
COMMENT ON COLUMN skill_install_logs.skill_package_id IS '关联的包记录 ID';
COMMENT ON COLUMN skill_install_logs.operation IS '操作类型（install/update/rollback/uninstall）';
COMMENT ON COLUMN skill_install_logs.status IS '状态（pending/running/success/failed）';
COMMENT ON COLUMN skill_install_logs.step IS '当前步骤';
COMMENT ON COLUMN skill_install_logs.progress IS '进度百分比（0-100）';

-- ============================================================================
-- 4. 数据迁移：从 skills 表迁移到新模型
-- ============================================================================

-- 迁移现有 skills 数据到 skill_definitions
INSERT INTO skill_definitions (
    id,
    skill_id,
    name,
    description,
    trigger_keywords,
    current_version,
    is_active,
    is_public,
    created_by,
    created_at,
    updated_at
)
SELECT
    id,
    COALESCE(
        config->>'source',
        CASE
            WHEN is_builtin THEN 'builtin-' || LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'))
            ELSE 'custom-' || LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'))
        END || '-' || SUBSTRING(id::text FROM 1 FOR 8)  -- 添加 UUID 前 8 位确保唯一性
    ) as skill_id,
    name,
    description,
    trigger_keywords,
    '1.0.0' as current_version,
    is_active,
    COALESCE(is_builtin, false) as is_public,
    created_by,
    created_at,
    updated_at
FROM skills
WHERE NOT EXISTS (
    SELECT 1 FROM skill_definitions sd
    WHERE sd.name = skills.name
);

-- 为每个迁移的 skill 创建对应的 package 记录
INSERT INTO skill_packages (
    skill_definition_id,
    version,
    source_type,
    source_url,
    manifest_content,
    package_path,
    checksum_sha256,
    status,
    tools,
    config,
    installed_at,
    installed_by,
    created_at,
    updated_at
)
SELECT
    sd.id as skill_definition_id,
    '1.0.0' as version,
    COALESCE(s.config->>'source', 'local') as source_type,
    s.config->>'sourceUrl' as source_url,
    jsonb_build_object(
        'skill_id', sd.skill_id,
        'version', '1.0.0',
        'name', s.name,
        'description', s.description,
        'trigger_keywords', to_jsonb(s.trigger_keywords)
    ) as manifest_content,
    'migrated/' || sd.skill_id || '/1.0.0' as package_path,
    encode(sha256(s.id::text::bytea), 'hex') as checksum_sha256,
    CASE WHEN s.is_active THEN 'active' ELSE 'deprecated' END as status,
    s.tools,
    s.config,
    s.created_at as installed_at,
    s.created_by as installed_by,
    s.created_at,
    s.updated_at
FROM skills s
JOIN skill_definitions sd ON sd.name = s.name
WHERE NOT EXISTS (
    SELECT 1 FROM skill_packages sp
    WHERE sp.skill_definition_id = sd.id AND sp.version = '1.0.0'
);

-- ============================================================================
-- 5. 更新 agent_skills 表以支持版本锁定
-- ============================================================================

-- 添加新列
ALTER TABLE agent_skills
ADD COLUMN IF NOT EXISTS skill_definition_id UUID,
ADD COLUMN IF NOT EXISTS version_lock VARCHAR(50),
ADD COLUMN IF NOT EXISTS auto_update BOOLEAN DEFAULT true;

-- 迁移数据
UPDATE agent_skills
SET skill_definition_id = sd.id
FROM skill_definitions sd
JOIN skills s ON s.name = sd.name
WHERE agent_skills.skill_id = s.id;

-- 添加索引
CREATE INDEX IF NOT EXISTS idx_agent_skills_definition ON agent_skills(skill_definition_id);

COMMENT ON COLUMN agent_skills.skill_definition_id IS '关联的技能定义 ID（新模型）';
COMMENT ON COLUMN agent_skills.version_lock IS '版本锁定（如 1.0.0, ^1.2.0, ~1.2.3）';
COMMENT ON COLUMN agent_skills.auto_update IS '是否自动更新到最新版本';

-- ============================================================================
-- 6. 保留 skills 表用于向后兼容（可选：后续版本可删除）
-- ============================================================================

-- 添加迁移标记
ALTER TABLE skills
ADD COLUMN IF NOT EXISTS migrated_to_definition_id UUID,
ADD COLUMN IF NOT EXISTS migration_status VARCHAR(20) DEFAULT 'pending';

-- 标记已迁移的记录
UPDATE skills
SET migrated_to_definition_id = sd.id,
    migration_status = 'completed'
FROM skill_definitions sd
WHERE skills.name = sd.name;

CREATE INDEX IF NOT EXISTS idx_skills_migration ON skills(migration_status);

COMMENT ON COLUMN skills.migrated_to_definition_id IS '迁移到的新模型 skill_definition ID';
COMMENT ON COLUMN skills.migration_status IS '迁移状态（pending/completed/failed）';
