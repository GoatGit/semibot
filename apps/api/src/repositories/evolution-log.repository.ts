import { sql } from '../lib/db'
import { logPaginationLimit } from '../lib/logger'

export interface EvolutionLogRow {
  id: string
  org_id: string
  agent_id: string
  session_id: string
  stage: string
  status: string
  evolved_skill_id: string | null
  input_data: Record<string, unknown> | null
  output_data: Record<string, unknown> | null
  error_message: string | null
  duration_ms: number | null
  tokens_used: number | null
  created_at: string
}

export interface CreateEvolutionLogData {
  orgId: string
  agentId: string
  sessionId: string
  stage: string
  status: string
  evolvedSkillId?: string | null
  inputData?: Record<string, unknown>
  outputData?: Record<string, unknown>
  errorMessage?: string
  durationMs?: number
  tokensUsed?: number
}

export interface FindEvolutionLogsParams {
  orgId: string
  agentId?: string
  stage?: string
  status?: string
  page?: number
  limit?: number
}

type SqlFragment = {
  __sqlFragment: true
  text: string
  values: unknown[]
}

const EMPTY_FRAGMENT: SqlFragment = {
  __sqlFragment: true,
  text: '',
  values: [],
}

function safePage(page?: number): number {
  return Math.max(1, Math.trunc(page ?? 1) || 1)
}

function safeLimit(limit?: number): number {
  const requested = Math.trunc(limit ?? 20) || 20
  const safe = Math.max(1, Math.min(100, requested))
  if (safe !== requested) {
    logPaginationLimit('evolution_logs', requested, safe, 100)
  }
  return safe
}

export async function create(data: CreateEvolutionLogData): Promise<EvolutionLogRow> {
  const rows = (await sql`
    INSERT INTO evolution_logs (
      org_id, agent_id, session_id, stage, status, evolved_skill_id,
      input_data, output_data, error_message, duration_ms, tokens_used
    ) VALUES (
      ${data.orgId}, ${data.agentId}, ${data.sessionId}, ${data.stage}, ${data.status},
      ${data.evolvedSkillId ?? null},
      ${sql.json(data.inputData ?? null)},
      ${sql.json(data.outputData ?? null)},
      ${data.errorMessage ?? null},
      ${data.durationMs ?? null},
      ${data.tokensUsed ?? null}
    )
    RETURNING *
  `) as EvolutionLogRow[]
  return rows[0]
}

export async function findByOrg(params: FindEvolutionLogsParams): Promise<{
  data: EvolutionLogRow[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}> {
  const page = safePage(params.page)
  const limit = safeLimit(params.limit)
  const offset = (page - 1) * limit
  const baseWhere = sql`org_id = ${params.orgId}`
  const agentWhere = params.agentId ? sql`AND agent_id = ${params.agentId}` : EMPTY_FRAGMENT
  const stageWhere = params.stage ? sql`AND stage = ${params.stage}` : EMPTY_FRAGMENT
  const statusWhere = params.status ? sql`AND status = ${params.status}` : EMPTY_FRAGMENT
  const countRows = (await sql`
    SELECT COUNT(*) as total
    FROM evolution_logs
    WHERE ${baseWhere} ${agentWhere} ${stageWhere} ${statusWhere}
  `) as Array<{ total: string | number }>
  const rows = (await sql`
    SELECT *
    FROM evolution_logs
    WHERE ${baseWhere} ${agentWhere} ${stageWhere} ${statusWhere}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as EvolutionLogRow[]
  const total = Number(countRows[0]?.total ?? 0)
  return {
    data: rows,
    meta: {
      total,
      page,
      limit,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
    },
  }
}

export async function findBySession(sessionId: string, orgId: string): Promise<EvolutionLogRow[]> {
  return (await sql`
    SELECT *
    FROM evolution_logs
    WHERE session_id = ${sessionId} AND org_id = ${orgId}
    ORDER BY created_at DESC
  `) as EvolutionLogRow[]
}

export async function findByEvolvedSkillId(evolvedSkillId: string): Promise<EvolutionLogRow[]> {
  return (await sql`
    SELECT *
    FROM evolution_logs
    WHERE evolved_skill_id = ${evolvedSkillId}
    ORDER BY created_at DESC
  `) as EvolutionLogRow[]
}
