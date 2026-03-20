/**
 * 本地 SQLite 数据库客户端
 *
 * 使用 better-sqlite3 连接 ~/.semibot/semibot.db
 * 与 Python runtime 共享同一个数据库文件
 */

import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createLogger } from './logger'

const logger = createLogger('db-local')

const DB_DIR = path.join(os.homedir(), '.semibot')
const DB_PATH = path.join(DB_DIR, 'semibot.db')

let _db: Database.Database | null = null

export function getLocalDb(): Database.Database {
  if (_db) return _db
  fs.mkdirSync(DB_DIR, { recursive: true })
  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = OFF')
  _db.pragma('synchronous = NORMAL')
  initSchema(_db)
  logger.info('SQLite 数据库已连接', { path: DB_PATH })
  return _db
}

export function closeLocalDb(): void {
  if (_db) {
    _db.close()
    _db = null
    logger.info('SQLite 数据库已关闭')
  }
}

// ─── Schema 初始化 ────────────────────────────────────────────

function initSchema(db: Database.Database): void {
  db.exec(`
    -- agents
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      system_prompt TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      skills_json TEXT NOT NULL DEFAULT '[]',
      sub_agents_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_public INTEGER NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 0,
      default_vm_mode TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );

    -- llm_providers
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      endpoint TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- llm_models
    CREATE TABLE IF NOT EXISTS llm_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '["chat"]',
      context_window INTEGER,
      max_output_tokens INTEGER,
      input_price_per_1k TEXT,
      output_price_per_1k TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- skill_definitions
    CREATE TABLE IF NOT EXISTS skill_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      category TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      schema_json TEXT NOT NULL DEFAULT '{}',
      config_schema_json TEXT NOT NULL DEFAULT '{}',
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      version TEXT NOT NULL DEFAULT '1.0.0',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    -- skill_packages
    CREATE TABLE IF NOT EXISTS skill_packages (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      runtime TEXT NOT NULL DEFAULT 'python',
      entry_point TEXT,
      package_path TEXT,
      checksum TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    -- skill_install_logs
    CREATE TABLE IF NOT EXISTS skill_install_logs (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      package_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    -- evolved_skills
    CREATE TABLE IF NOT EXISTS evolved_skills (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      trigger_keywords_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      tools_used_json TEXT NOT NULL DEFAULT '[]',
      parameters_json TEXT NOT NULL DEFAULT '{}',
      preconditions_json TEXT NOT NULL DEFAULT '{}',
      expected_outcome TEXT,
      embedding_json TEXT,
      quality_score REAL NOT NULL DEFAULT 0,
      reusability_score REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_review',
      use_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      review_comment TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evolved_skills_agent ON evolved_skills(agent_id, status);

    -- sessions (metadata only, messages stay in checkpoints)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'local',
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT,
      metadata_json TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, created_at);

    -- context_policy_docs
    CREATE TABLE IF NOT EXISTS context_policy_docs (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'approved',
      content TEXT NOT NULL,
      source_candidate_id TEXT,
      change_note TEXT,
      last_reviewed_by TEXT,
      last_reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );

    -- memories (long-term)
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      content TEXT NOT NULL,
      embedding_json TEXT,
      memory_type TEXT NOT NULL DEFAULT 'episodic',
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, memory_type);

    -- short_term_memory
    CREATE TABLE IF NOT EXISTS short_term_memory (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stm_session ON short_term_memory(session_id);

    -- execution_logs
    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request_id TEXT,
      step_id TEXT,
      action_id TEXT,
      state TEXT NOT NULL,
      action_type TEXT,
      action_name TEXT,
      action_input_json TEXT,
      action_output_json TEXT,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_logs_session ON execution_logs(session_id, created_at);

    -- usage_records
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      period_type TEXT NOT NULL,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      api_calls INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      sessions_count INTEGER NOT NULL DEFAULT 0,
      messages_count INTEGER NOT NULL DEFAULT 0,
      errors_count INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- api_keys
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );

    -- webhooks
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      events_json TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      failure_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );

    -- webhook_deliveries
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      error_message TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      delivered_at TEXT,
      created_at TEXT NOT NULL
    );

    -- snapshots
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      checkpoint_id TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id, created_at);

    -- evolution_capabilities
    CREATE TABLE IF NOT EXISTS evolution_capabilities (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      capability_type TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- studios (Agent Studio 工作室定义)
    CREATE TABLE IF NOT EXISTS studios (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      nodes_json TEXT NOT NULL DEFAULT '[]',
      edges_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );

    -- studio_runs (Studio 运行实例)
    CREATE TABLE IF NOT EXISTS studio_runs (
      id TEXT PRIMARY KEY,
      studio_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      inputs_json TEXT NOT NULL DEFAULT '{}',
      current_node_id TEXT,
      node_results_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_studio_runs_studio ON studio_runs(studio_id, created_at);
  `)

  // ─── Migrations (idempotent) ──────────────────────────────────
  const defaultOrg = process.env.SEMIBOT_SINGLE_ORG_ID || '11111111-1111-1111-1111-111111111111'

  // Add org_id column to sessions if missing (pre-existing DBs)
  const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'org_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'local'`)
    logger.info('Migration: sessions 表已添加 org_id 列')
  }

  // Backfill org_id for any sessions still set to 'local'
  const backfilled = db.prepare("UPDATE sessions SET org_id = ? WHERE org_id = 'local'").run(defaultOrg)
  if ((backfilled.changes ?? 0) > 0) {
    logger.info('Migration: 已回填 sessions.org_id', { count: backfilled.changes, defaultOrg })
  }

  // Drop deprecated agents.openclaw_config_json and legacy runtime_type by table rebuild when present.
  const agentCols = db.prepare("PRAGMA table_info('agents')").all() as Array<{ name: string }>
  if (agentCols.some((c) => c.name === 'openclaw_config_json') || agentCols.some((c) => c.name === 'runtime_type')) {
    db.exec(`
      BEGIN;
      CREATE TABLE agents__new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        system_prompt TEXT NOT NULL DEFAULT '',
        config_json TEXT NOT NULL DEFAULT '{}',
        skills_json TEXT NOT NULL DEFAULT '[]',
        sub_agents_json TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_public INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        default_vm_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT
      );
      INSERT INTO agents__new (
        id, name, description, system_prompt, config_json, skills_json, sub_agents_json,
        version, is_active, is_public, is_system, default_vm_mode,
        created_at, updated_at, deleted_at, deleted_by
      )
      SELECT
        id, name, description, system_prompt, config_json, skills_json, sub_agents_json,
        version, is_active, is_public, is_system, default_vm_mode,
        created_at, updated_at, deleted_at, deleted_by
      FROM agents;
      DROP TABLE agents;
      ALTER TABLE agents__new RENAME TO agents;
      COMMIT;
    `)
    logger.info('Migration: agents 表已移除废弃列', { removed: ['openclaw_config_json', 'runtime_type'] })
  }

  const sessionCols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
  if (sessionCols.some((c) => c.name === 'runtime_type')) {
    db.exec(`
      BEGIN;
      CREATE TABLE sessions__new (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL DEFAULT 'local',
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT,
        metadata_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT
      );
      INSERT INTO sessions__new (
        id, org_id, agent_id, user_id, status, title, metadata_json,
        started_at, ended_at, created_at, deleted_at, deleted_by
      )
      SELECT
        id, org_id, agent_id, user_id, status, title, metadata_json,
        started_at, ended_at, created_at, deleted_at, deleted_by
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions__new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, created_at);
      COMMIT;
    `)
    logger.info('Migration: sessions 表已移除废弃列', { removed: ['runtime_type'] })
  }
}
