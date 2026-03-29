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

function resolveDbPath(): { dir: string; path: string } {
  const explicitPath = String(process.env.SEMIBOT_DB_PATH || '').trim()
  if (explicitPath) {
    return {
      dir: path.dirname(explicitPath),
      path: explicitPath,
    }
  }

  const explicitHome = String(process.env.SEMIBOT_HOME || '').trim()
  const dir = explicitHome || path.join(os.homedir(), '.semibot')
  return {
    dir,
    path: path.join(dir, 'semibot.db'),
  }
}

let _db: Database.Database | null = null

export function getLocalDb(): Database.Database {
  if (_db) {
    applyIncrementalMigrations(_db)
    return _db
  }
  const { dir: dbDir, path: dbPath } = resolveDbPath()
  fs.mkdirSync(dbDir, { recursive: true })
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = OFF')
  _db.pragma('synchronous = NORMAL')
  initSchema(_db)
  logger.info('SQLite 数据库已连接', { path: dbPath })
  return _db
}

export function closeLocalDb(): void {
  if (_db) {
    _db.close()
    _db = null
    logger.info('SQLite 数据库已关闭')
  }
}

export function ensureLocalDbSchema(): Database.Database {
  const db = getLocalDb()
  applyIncrementalMigrations(db)
  return db
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

    -- sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'local',
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'active',
      current_attempt_id TEXT,
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

    -- messages
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      attempt_id TEXT,
      user_message_id TEXT,
      parent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_calls_json TEXT,
      tool_call_id TEXT,
      tokens_used INTEGER,
      latency_ms INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      deleted_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session_created_at ON messages(session_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_stm_session ON short_term_memory(session_id);

    -- runtime_attempts
    CREATE TABLE IF NOT EXISTS runtime_attempts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      attempt_seq INTEGER NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL,
      approval_set_revision INTEGER NOT NULL DEFAULT 0,
      approval_block_count INTEGER NOT NULL DEFAULT 0,
      resume_count INTEGER NOT NULL DEFAULT 0,
      latest_revision INTEGER NOT NULL DEFAULT 0,
      checkpoint_id TEXT,
      artifact_message_id TEXT,
      terminal_reason TEXT,
      leased_by TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_attempts_user_message_seq
      ON runtime_attempts(user_message_id, attempt_seq);
    CREATE INDEX IF NOT EXISTS idx_runtime_attempts_session_started_at
      ON runtime_attempts(session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runtime_attempts_status_updated_at
      ON runtime_attempts(status, updated_at);

    -- runtime_attempt_checkpoints
    CREATE TABLE IF NOT EXISTS runtime_attempt_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_attempt_checkpoints_attempt_revision
      ON runtime_attempt_checkpoints(attempt_id, revision);
    CREATE INDEX IF NOT EXISTS idx_runtime_attempt_checkpoints_session_created_at
      ON runtime_attempt_checkpoints(session_id, created_at);

    -- event_outbox
    CREATE TABLE IF NOT EXISTS event_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_idempotency
      ON event_outbox(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_event_outbox_attempt_revision
      ON event_outbox(attempt_id, revision DESC);

    -- checkpoint_outbox
    CREATE TABLE IF NOT EXISTS checkpoint_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      projection_target TEXT NOT NULL DEFAULT 'local_file',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoint_outbox_attempt_revision
      ON checkpoint_outbox(attempt_id, revision DESC);

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

    -- productions (APS 顶层实体)
    CREATE TABLE IF NOT EXISTS productions (
      production_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      constraints_json TEXT NOT NULL DEFAULT '{}',
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      current_plan_id TEXT,
      current_stage_id TEXT,
      is_paused INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_productions_status_created_at
      ON productions(status, created_at);

    -- production_plans (planner snapshot)
    CREATE TABLE IF NOT EXISTS production_plans (
      plan_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      plan_version INTEGER NOT NULL,
      schema_version TEXT NOT NULL,
      planner_type TEXT NOT NULL DEFAULT 'default',
      rationale TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      graph_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_production_plans_prod_version
      ON production_plans(production_id, plan_version);

    -- production_stages
    CREATE TABLE IF NOT EXISTS production_stages (
      stage_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      exit_criteria TEXT,
      review_gate_config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_stages_prod_sequence
      ON production_stages(production_id, sequence);

    -- production_tasks
    CREATE TABLE IF NOT EXISTS production_tasks (
      task_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      task_key TEXT NOT NULL,
      title TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      goal TEXT NOT NULL,
      depends_on_task_ids_json TEXT NOT NULL DEFAULT '[]',
      input_artifact_refs_json TEXT NOT NULL DEFAULT '[]',
      output_contract_json TEXT NOT NULL DEFAULT '[]',
      review_policy_json TEXT NOT NULL DEFAULT '{}',
      execution_policy_json TEXT NOT NULL DEFAULT '{}',
      budget_policy_json TEXT NOT NULL DEFAULT '{}',
      leased_by TEXT,
      lease_expires_at TEXT,
      current_attempt_id TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_production_tasks_prod_status_priority
      ON production_tasks(production_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_production_tasks_stage_status
      ON production_tasks(stage_id, status);

    -- task_attempts
    CREATE TABLE IF NOT EXISTS task_attempts (
      task_attempt_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      worker_id TEXT,
      status TEXT NOT NULL,
      input_envelope_json TEXT NOT NULL,
      output_result_json TEXT,
      lease_expires_at TEXT,
      heartbeat_at TEXT,
      checkpoint_ref TEXT,
      failure_kind TEXT,
      failure_detail_json TEXT NOT NULL DEFAULT '{}',
      usage_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_task_attempt_no
      ON task_attempts(task_id, attempt_no);
    CREATE INDEX IF NOT EXISTS idx_task_attempts_status_lease
      ON task_attempts(status, lease_expires_at);

    -- artifact_versions
    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_version_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      review_state TEXT NOT NULL,
      storage_uri TEXT NOT NULL,
      summary TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      lineage_refs_json TEXT NOT NULL DEFAULT '[]',
      created_by_task_id TEXT,
      created_by_attempt_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_versions_prod_key_version
      ON artifact_versions(production_id, artifact_key, version);
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_prod_review_state
      ON artifact_versions(production_id, review_state, created_at);

    -- review_jobs
    CREATE TABLE IF NOT EXISTS review_jobs (
      review_job_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_attempt_id TEXT NOT NULL,
      artifact_version_id TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      reviewer_type TEXT NOT NULL,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_jobs_attempt_reviewer
      ON review_jobs(task_attempt_id, reviewer_role, reviewer_type);
    CREATE INDEX IF NOT EXISTS idx_review_jobs_status_created
      ON review_jobs(status, created_at);

    -- review_decisions
    CREATE TABLE IF NOT EXISTS review_decisions (
      review_decision_id TEXT PRIMARY KEY,
      review_job_id TEXT NOT NULL,
      production_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      task_attempt_id TEXT NOT NULL,
      reviewer_role TEXT NOT NULL,
      reviewer_type TEXT NOT NULL,
      decision TEXT NOT NULL,
      score REAL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      revision_request_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_review_decisions_job
      ON review_decisions(review_job_id);
    CREATE INDEX IF NOT EXISTS idx_review_decisions_prod_decision
      ON review_decisions(production_id, decision, created_at);

    -- escalations
    CREATE TABLE IF NOT EXISTS escalations (
      escalation_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      stage_id TEXT,
      task_id TEXT,
      task_attempt_id TEXT,
      artifact_version_id TEXT,
      source_type TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_escalations_status_created
      ON escalations(status, created_at);

    -- human_decisions
    CREATE TABLE IF NOT EXISTS human_decisions (
      human_decision_id TEXT PRIMARY KEY,
      escalation_id TEXT NOT NULL,
      production_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      decided_by TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_human_decisions_escalation
      ON human_decisions(escalation_id, created_at);

    -- production_events
    CREATE TABLE IF NOT EXISTS production_events (
      production_event_id TEXT PRIMARY KEY,
      production_id TEXT NOT NULL,
      stage_id TEXT,
      task_id TEXT,
      task_attempt_id TEXT,
      event_type TEXT NOT NULL,
      event_version TEXT NOT NULL DEFAULT '1',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_production_events_prod_created
      ON production_events(production_id, created_at);
  `)

  applyIncrementalMigrations(db)
}

function applyIncrementalMigrations(db: Database.Database): void {
  const defaultOrg = process.env.SEMIBOT_SINGLE_ORG_ID || '11111111-1111-1111-1111-111111111111'

  // Add org_id column to sessions if missing (pre-existing DBs)
  const cols = db.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'org_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN org_id TEXT NOT NULL DEFAULT 'local'`)
    logger.info('Migration: sessions 表已添加 org_id 列')
  }
  if (!cols.some((c) => c.name === 'current_attempt_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN current_attempt_id TEXT`)
    logger.info('Migration: sessions 表已添加 current_attempt_id 列')
  }

  const messageCols = db.prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>
  if (!messageCols.some((c) => c.name === 'attempt_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN attempt_id TEXT`)
    logger.info('Migration: messages 表已添加 attempt_id 列')
  }
  if (!messageCols.some((c) => c.name === 'user_message_id')) {
    db.exec(`ALTER TABLE messages ADD COLUMN user_message_id TEXT`)
    logger.info('Migration: messages 表已添加 user_message_id 列')
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_attempt_created_at ON messages(attempt_id, created_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_user_message_created_at ON messages(user_message_id, created_at)`)

  const runtimeAttemptCols = db.prepare("PRAGMA table_info('runtime_attempts')").all() as Array<{ name: string }>
  if (!runtimeAttemptCols.some((c) => c.name === 'latest_revision')) {
    db.exec(`ALTER TABLE runtime_attempts ADD COLUMN latest_revision INTEGER NOT NULL DEFAULT 0`)
    logger.info('Migration: runtime_attempts 表已添加 latest_revision 列')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_idempotency ON event_outbox(idempotency_key)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_event_outbox_attempt_revision ON event_outbox(attempt_id, revision DESC)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_outbox (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      projection_target TEXT NOT NULL DEFAULT 'local_file',
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_checkpoint_outbox_attempt_revision ON checkpoint_outbox(attempt_id, revision DESC)`)

  const productionPlanCols = db.prepare("PRAGMA table_info('production_plans')").all() as Array<{ name: string }>
  if (!productionPlanCols.some((c) => c.name === 'metadata_json')) {
    db.exec(`ALTER TABLE production_plans ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`)
    logger.info('Migration: production_plans 表已添加 metadata_json 列')
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
        current_attempt_id TEXT,
        title TEXT,
        metadata_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT
      );
      INSERT INTO sessions__new (
        id, org_id, agent_id, user_id, status, current_attempt_id, title, metadata_json,
        started_at, ended_at, created_at, deleted_at, deleted_by
      )
      SELECT
        id, org_id, agent_id, user_id, status, NULL, title, metadata_json,
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
