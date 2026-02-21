BEGIN;

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_bootstrap_attempts
  ON user_vm_instances(bootstrap_attempts DESC);

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_bootstrap_error
  ON user_vm_instances(id)
  WHERE bootstrap_last_error IS NOT NULL;

COMMIT;
