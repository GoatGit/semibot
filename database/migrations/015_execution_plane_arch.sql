-- Execution Plane Architecture refactor
-- Date: 2026-02-22

BEGIN;

-- ============================================================
-- Routing and VM mode flags
-- ============================================================
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS routing_mode VARCHAR(20) DEFAULT 'http';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_vm_mode VARCHAR(20) DEFAULT 'docker';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS routing_mode VARCHAR(20);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vm_mode VARCHAR(20);

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS default_vm_mode VARCHAR(20) DEFAULT 'docker';

-- ============================================================
-- Dual runtime fields
-- ============================================================
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_type VARCHAR(20) DEFAULT 'semigraph';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS openclaw_config JSONB;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS runtime_type VARCHAR(20);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_runtime_type VARCHAR(20);

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS default_runtime_type VARCHAR(20);

-- ============================================================
-- User VM instance table
-- ============================================================
CREATE TABLE IF NOT EXISTS user_vm_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  mode VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'starting',
  vm_id VARCHAR(255),
  disk_id VARCHAR(255),
  ip_address VARCHAR(45),
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  terminated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_user
  ON user_vm_instances(user_id);

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_active
  ON user_vm_instances(status)
  WHERE status NOT IN ('terminated', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_vm_one_active
  ON user_vm_instances(user_id)
  WHERE status NOT IN ('terminated', 'failed');

-- ============================================================
-- Session snapshots table
-- ============================================================
CREATE TABLE IF NOT EXISTS session_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL,
  user_id UUID NOT NULL,
  org_id UUID NOT NULL,
  checkpoint JSONB,
  short_term_memory JSONB,
  conversation_state JSONB,
  file_manifest JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_snapshots_session
  ON session_snapshots(session_id);

CREATE INDEX IF NOT EXISTS idx_session_snapshots_latest
  ON session_snapshots(session_id, created_at DESC);

COMMIT;
