import { createError } from '../middleware/errorHandler'
import { DATABASE_ERROR, RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as contextPolicyRepo from '../repositories/context-policy.repository'

export type ContextPolicyDocType = contextPolicyRepo.ContextPolicyDocType

export interface ContextPolicyDoc {
  id: string
  docType: ContextPolicyDocType
  version: string
  status: 'draft' | 'review_required' | 'approved' | 'archived'
  content: string
  changeNote?: string
  updatedAt: string
}

const DOC_TYPES: ContextPolicyDocType[] = ['gene', 'agents', 'tools']
const DEFAULT_POLICY_CONTENT: Record<ContextPolicyDocType, string> = {
  gene: [
    '你是 Semibot 的组织级执行智能体。',
    '目标：安全、准确、可追溯地完成任务。',
    '1) 优先给出可执行结果，必要时说明假设。',
    '2) 涉及高风险操作时先提示风险并遵循审批流程。',
    '3) 输出保持结构化、简洁。',
  ].join('\n'),
  agents: [
    'Agent 选择策略：',
    '1) 优先选择最小权限且与任务最匹配的 Agent。',
    '2) 无明确匹配时使用默认 Agent。',
    '3) 需要切换 Agent 时，先说明原因再执行。',
  ].join('\n'),
  tools: [
    'Tool 使用策略：',
    '1) 先读后写，先低风险后高风险。',
    '2) 外部请求遵循最小权限、超时与重试限制。',
    '3) 返回统一结构：summary、evidence、next_action。',
  ].join('\n'),
}

function buildDefaultDoc(docType: ContextPolicyDocType): ContextPolicyDoc {
  return {
    id: '',
    docType,
    version: 'v0',
    status: 'approved',
    content: DEFAULT_POLICY_CONTENT[docType],
    updatedAt: '',
  }
}

function isMissingContextPolicyTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const payload = error as { code?: string; message?: string }
  if (payload.code === '42P01') return true
  return String(payload.message || '').includes('relation "context_policy_docs" does not exist')
}

function rowToDoc(row: contextPolicyRepo.ContextPolicyDocRow): ContextPolicyDoc {
  return {
    id: row.id,
    docType: row.doc_type,
    version: row.version,
    status: row.status,
    content: row.content,
    changeNote: row.change_note ?? undefined,
    updatedAt: row.updated_at,
  }
}

function normalizeDocType(value: string): ContextPolicyDocType {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'gene' || normalized === 'agents' || normalized === 'tools') {
    return normalized
  }
  throw createError(RESOURCE_NOT_FOUND, `Unsupported doc type: ${value}`)
}

export async function getActivePolicies(orgId: string): Promise<ContextPolicyDoc[]> {
  try {
    const latestRows = await contextPolicyRepo.listLatestApprovedByOrg(orgId)
    const byType = new Map(latestRows.map((row) => [row.doc_type, rowToDoc(row)]))
    return DOC_TYPES.map((docType) => byType.get(docType) ?? buildDefaultDoc(docType))
  } catch (error) {
    if (isMissingContextPolicyTableError(error)) {
      return DOC_TYPES.map((docType) => buildDefaultDoc(docType))
    }
    throw error
  }
}

export async function getPolicyVersions(
  orgId: string,
  docTypeInput: string,
  limit = 20
): Promise<ContextPolicyDoc[]> {
  const docType = normalizeDocType(docTypeInput)
  try {
    const rows = await contextPolicyRepo.listByOrgAndType(orgId, docType, limit)
    return rows.map(rowToDoc)
  } catch (error) {
    if (isMissingContextPolicyTableError(error)) {
      return [buildDefaultDoc(docType)]
    }
    throw error
  }
}

export async function updatePolicy(
  orgId: string,
  userId: string,
  docTypeInput: string,
  content: string,
  changeNote?: string
): Promise<ContextPolicyDoc> {
  const docType = normalizeDocType(docTypeInput)
  try {
    const row = await contextPolicyRepo.createApprovedVersion({
      orgId,
      docType,
      content,
      reviewedBy: userId,
      changeNote,
    })
    return rowToDoc(row)
  } catch (error) {
    if (isMissingContextPolicyTableError(error)) {
      throw createError(DATABASE_ERROR, 'Context policy schema is not initialized. Please run database migrations.')
    }
    throw error
  }
}

export async function rollbackPolicy(
  orgId: string,
  userId: string,
  docTypeInput: string,
  targetVersion: string,
  reason?: string
): Promise<ContextPolicyDoc> {
  const docType = normalizeDocType(docTypeInput)
  try {
    const target = await contextPolicyRepo.findByOrgTypeAndVersion(orgId, docType, targetVersion)
    if (!target) {
      throw createError(RESOURCE_NOT_FOUND, `Version not found: ${targetVersion}`)
    }
    const row = await contextPolicyRepo.createApprovedVersion({
      orgId,
      docType,
      content: target.content,
      reviewedBy: userId,
      changeNote: reason || `rollback to ${targetVersion}`,
    })
    return rowToDoc(row)
  } catch (error) {
    if (isMissingContextPolicyTableError(error)) {
      throw createError(DATABASE_ERROR, 'Context policy schema is not initialized. Please run database migrations.')
    }
    throw error
  }
}

export function buildPolicyInjectionBlock(docs: ContextPolicyDoc[]): string {
  const byType = new Map(docs.map((d) => [d.docType, d]))
  const gene = byType.get('gene')?.content?.trim() || ''
  const agents = byType.get('agents')?.content?.trim() || ''
  const tools = byType.get('tools')?.content?.trim() || ''
  const hasAny = Boolean(gene || agents || tools)
  if (!hasAny) return ''

  const sections: string[] = []
  sections.push('<policy_gene>')
  sections.push(gene || 'No gene policy configured.')
  sections.push('</policy_gene>')
  sections.push('<policy_agents>')
  sections.push(agents || 'No agents policy configured.')
  sections.push('</policy_agents>')
  sections.push('<policy_tools>')
  sections.push(tools || 'No tools policy configured.')
  sections.push('</policy_tools>')
  return sections.join('\n')
}
