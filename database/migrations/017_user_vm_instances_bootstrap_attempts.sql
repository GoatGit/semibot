BEGIN;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS last_bootstrap_at TIMESTAMPTZ;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS bootstrap_attempts INTEGER DEFAULT 0;

UPDATE user_vm_instances
SET bootstrap_attempts = COALESCE(bootstrap_attempts, 0)
WHERE bootstrap_attempts IS NULL;

COMMIT;
