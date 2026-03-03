-- 021_add_context_policy_tables.sql
-- Context injection policy docs and patch candidates

CREATE TABLE IF NOT EXISTS context_policy_docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    doc_type VARCHAR(20) NOT NULL CHECK (doc_type IN ('gene', 'agents', 'tools')),
    version VARCHAR(32) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'review_required', 'approved', 'archived')),
    content TEXT NOT NULL DEFAULT '',
    source_candidate_id UUID,
    change_note TEXT,
    last_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    last_reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(org_id, doc_type, version)
);

CREATE INDEX IF NOT EXISTS idx_context_policy_docs_org_type_status
    ON context_policy_docs(org_id, doc_type, status, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_context_policy_docs_org_type_created
    ON context_policy_docs(org_id, doc_type, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS context_policy_patch_candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    doc_type VARCHAR(20) NOT NULL CHECK (doc_type IN ('gene', 'agents', 'tools')),
    target_version VARCHAR(32) NOT NULL,
    patch_unified_diff TEXT NOT NULL,
    rationale TEXT,
    source_learning_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_capability_id UUID,
    risk_level VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
    status VARCHAR(20) NOT NULL DEFAULT 'review_required' CHECK (status IN ('review_required', 'approved', 'rejected', 'applied')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    deleted_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_context_policy_patch_candidates_org_doc_status
    ON context_policy_patch_candidates(org_id, doc_type, status, created_at DESC)
    WHERE deleted_at IS NULL;

COMMENT ON TABLE context_policy_docs IS 'Context injection policy source of truth for GENE/AGENTS/TOOLS';
COMMENT ON TABLE context_policy_patch_candidates IS 'Patch proposal queue for context policy docs';
