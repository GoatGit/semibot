BEGIN;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS bootstrap_last_error TEXT;

COMMIT;
