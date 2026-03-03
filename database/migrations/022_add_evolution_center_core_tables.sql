-- 022_add_evolution_center_core_tables.sql
-- Evolution Center (manual version switching) - minimal core schema

CREATE TABLE IF NOT EXISTS learning_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category VARCHAR(32) NOT NULL CHECK (category IN (
        'correction',
        'error',
        'feature_gap',
        'knowledge_gap',
        'best_practice'
    )),
    status VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending',
        'in_progress',
        'resolved',
        'promoted',
        'promoted_to_capability'
    )),
    summary TEXT NOT NULL,
    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_learning_records_org_created
    ON learning_records(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS capability_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type VARCHAR(24) NOT NULL CHECK (type IN ('hands', 'reflex', 'spine', 'guard', 'mind')),
    name VARCHAR(120) NOT NULL,
    spec_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    contract_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_learning_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    risk_level VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    extraction_confidence NUMERIC(4, 3) NOT NULL DEFAULT 0 CHECK (extraction_confidence >= 0 AND extraction_confidence <= 1),
    status VARCHAR(24) NOT NULL DEFAULT 'observed' CHECK (status IN ('observed', 'applied', 'rolled_back', 'deprecated')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS capability_candidates_updated_at ON capability_candidates;

CREATE TRIGGER capability_candidates_updated_at
    BEFORE UPDATE ON capability_candidates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE INDEX IF NOT EXISTS idx_capability_candidates_org_status
    ON capability_candidates(org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capability_candidates_org_type
    ON capability_candidates(org_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS capability_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    capability_type VARCHAR(24) NOT NULL CHECK (capability_type IN ('hands', 'reflex', 'spine', 'guard', 'mind')),
    version VARCHAR(32) NOT NULL,
    content_text TEXT NOT NULL,
    checksum VARCHAR(128) NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(org_id, capability_type, version)
);

CREATE INDEX IF NOT EXISTS idx_capability_versions_org_type_created
    ON capability_versions(org_id, capability_type, created_at DESC);

CREATE TABLE IF NOT EXISTS capability_releases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    capability_type VARCHAR(24) NOT NULL CHECK (capability_type IN ('hands', 'reflex', 'spine', 'guard', 'mind')),
    from_version VARCHAR(32),
    to_version VARCHAR(32) NOT NULL,
    action VARCHAR(24) NOT NULL DEFAULT 'switch_version' CHECK (action IN ('create_version', 'switch_version', 'rollback_version')),
    operator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    change_note TEXT,
    metrics_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capability_releases_org_type_created
    ON capability_releases(org_id, capability_type, created_at DESC);

COMMENT ON TABLE learning_records IS 'Evolution learning units captured from task/tool/feedback events';
COMMENT ON TABLE capability_candidates IS 'Evolution candidate objects waiting for manual apply/rollback decision';
COMMENT ON TABLE capability_versions IS 'Versioned capability contents for hands/reflex/spine/guard/mind';
COMMENT ON TABLE capability_releases IS 'Manual version switch/rollback audit trail for evolution center';
