BEGIN;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

UPDATE user_vm_instances
SET
  updated_at = COALESCE(updated_at, created_at),
  last_heartbeat_at = COALESCE(last_heartbeat_at, created_at)
WHERE updated_at IS NULL
   OR last_heartbeat_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_updated_at
  ON user_vm_instances(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_last_heartbeat
  ON user_vm_instances(last_heartbeat_at DESC);

COMMIT;
