-- ═══════════════════════════════════════════════════════════════
-- Migration 013: 系统默认 Agent + 系统预装能力
--
-- 引入系统级 Agent 和 MCP Server 概念：
-- 1. agents 表新增 is_system 列，org_id 改为 nullable
-- 2. mcp_servers 表新增 is_system 列，org_id 改为 nullable
-- 3. 唯一约束确保系统级资源全局唯一
-- 4. Seed 系统默认 Agent
-- ═══════════════════════════════════════════════════════════════

-- 1. agents 表：新增 is_system 列
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- 2. agents 表：org_id 改为 nullable（系统 Agent 无 org）
ALTER TABLE agents ALTER COLUMN org_id DROP NOT NULL;

-- 3. mcp_servers 表：新增 is_system 列
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

-- 4. mcp_servers 表：org_id 改为 nullable
ALTER TABLE mcp_servers ALTER COLUMN org_id DROP NOT NULL;

-- 5. 系统 Agent 唯一约束（全局只能有一个 is_system=true 的 Agent）
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_system
  ON agents(is_system) WHERE is_system = true;

-- 6. 系统 MCP 唯一名称约束（系统级 MCP 名称不可重复）
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_system_name
  ON mcp_servers(name) WHERE is_system = true;

-- 7. Seed 系统默认 Agent
INSERT INTO agents (
  id, org_id, name, description, system_prompt, config,
  skills, sub_agents, is_system, is_active, is_public, version
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  NULL,
  '系统助手',
  '系统默认 AI 助手，可使用所有系统预装能力',
  'You are a helpful AI assistant with access to system tools and capabilities.',
  '{"model":"gpt-4o","temperature":0.7,"maxTokens":4096,"timeoutSeconds":120}'::jsonb,
  '{}',
  '{}',
  true,
  true,
  true,
  1
)
ON CONFLICT (id) DO NOTHING;
