-- Webhook 事件分发系统
-- 包含 webhooks 订阅表和 webhook_logs 推送日志表

-- ═══════════════════════════════════════════════════════════════
-- webhooks 订阅表
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  url TEXT NOT NULL,
  secret VARCHAR(255) NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  failure_count INT NOT NULL DEFAULT 0,
  last_triggered_at TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,

  CONSTRAINT webhooks_url_not_empty CHECK (url <> ''),
  CONSTRAINT webhooks_secret_not_empty CHECK (secret <> ''),
  CONSTRAINT webhooks_failure_count_non_negative CHECK (failure_count >= 0)
);

COMMENT ON TABLE webhooks IS 'Webhook 订阅表';
COMMENT ON COLUMN webhooks.events IS '订阅的事件类型数组';
COMMENT ON COLUMN webhooks.secret IS 'HMAC-SHA256 签名密钥';
COMMENT ON COLUMN webhooks.failure_count IS '连续失败次数，成功后重置为 0';

CREATE INDEX IF NOT EXISTS idx_webhooks_org_id ON webhooks (org_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhooks_org_active ON webhooks (org_id, is_active) WHERE deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════
-- webhook_logs 推送日志表
-- ══════════════════��════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhooks(id),
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  response_status INT,
  response_body TEXT,
  attempt INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT webhook_logs_status_check CHECK (status IN ('pending', 'success', 'failed')),
  CONSTRAINT webhook_logs_attempt_positive CHECK (attempt > 0)
);

COMMENT ON TABLE webhook_logs IS 'Webhook 推送日志表';

CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook_id ON webhook_logs (webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at ON webhook_logs (created_at);
