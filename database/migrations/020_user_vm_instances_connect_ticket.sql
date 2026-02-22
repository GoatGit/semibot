-- Add one-time connect ticket fields for VM websocket handshake
-- Date: 2026-02-23

BEGIN;

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS connect_ticket UUID DEFAULT gen_random_uuid();

ALTER TABLE user_vm_instances
  ADD COLUMN IF NOT EXISTS ticket_used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_vm_instances_connect_ticket
  ON user_vm_instances(connect_ticket)
  WHERE status IN ('starting', 'provisioning', 'running', 'ready', 'disconnected');

COMMIT;
