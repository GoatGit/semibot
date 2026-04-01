import { createHash } from 'crypto'
import { createError } from '../middleware/errorHandler'
import { RESOURCE_NOT_FOUND } from '../constants/errorCodes'
import * as repo from '../repositories/evolution-capability.repository'

export type EvolutionCapabilityType = repo.EvolutionCapabilityType

export interface EvolutionCapabilityDoc {
  id: string
  capabilityType: EvolutionCapabilityType
  version: string
  content: string
  updatedAt: string
}

const CAPABILITY_TYPES: EvolutionCapabilityType[] = ['hands', 'reflex', 'spine', 'guard', 'mind']

const DEFAULT_CAPABILITY_CONTENT: Record<EvolutionCapabilityType, string> = {
  hands: [
    '能力定义要求：',
    '1) 给出明确输入、输出与失败语义。',
    '2) 优先复用已有能力，避免重复实现。',
    '3) 执行前声明前置条件与幂等性边界。',
  ].join('\n'),
  reflex: [
    '规则模板策略：',
    '1) 优先沉淀高复发、低歧义的触发条件。',
    '2) 动作模板需可参数化并可人工审阅。',
    '3) 默认不自动启用规则，由人工确认发布。',
  ].join('\n'),
  spine: [
    '规划策略：',
    '1) 先拆解目标，再选择最小可行步骤。',
    '2) 不改变 planner 既有 JSON 协议。',
    '3) 规划失败时回退到上一稳定策略。',
  ].join('\n'),
  guard: [
    '工具策略：',
    '1) 先低风险后高风险，先读后写。',
    '2) 高风险工具优先走审批链路。',
    '3) 工具失败时优先使用低风险替代路径。',
  ].join('\n'),
  mind: [
    '全局行为基线：',
    '1) 目标是安全、准确、可追溯地完成任务。',
    '2) 输出保持结构化、简洁并说明关键假设。',
    '3) 安全与合规条款优先于便捷性。',
  ].join('\n'),
}

function toVersionNumber(version: string | null | undefined): number {
  const match = /^v(\d+)$/i.exec(String(version || '').trim())
  return match ? (Number.parseInt(match[1], 10) || 0) : 0
}

function toVersionLabel(n: number): string {
  return `v${Math.max(1, n)}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeType(value: string): EvolutionCapabilityType {
  const normalized = value.trim().toLowerCase()
  if (CAPABILITY_TYPES.includes(normalized as EvolutionCapabilityType)) {
    return normalized as EvolutionCapabilityType
  }
  throw createError(RESOURCE_NOT_FOUND, `Unsupported capability type: ${value}`)
}

function rowToDoc(row: repo.CapabilityVersionRow): EvolutionCapabilityDoc {
  return {
    id: row.id,
    capabilityType: row.capability_type,
    version: row.version,
    content: row.content_text,
    updatedAt: row.created_at,
  }
}

async function ensureBootstrap(orgId: string, userId?: string): Promise<void> {
  const latestByType = await repo.listLatestVersionsByOrg(orgId)
  const existingTypes = new Set(latestByType.map((row) => row.capability_type))
  for (const capabilityType of CAPABILITY_TYPES) {
    if (existingTypes.has(capabilityType)) continue
    const content = DEFAULT_CAPABILITY_CONTENT[capabilityType]
    await repo.createVersion({
      orgId, capabilityType, version: 'v1', content, checksum: sha256(content), createdBy: userId,
    })
    await repo.createRelease({
      orgId, capabilityType, fromVersion: null, toVersion: 'v1',
      action: 'create_version', operatorId: userId, changeNote: 'bootstrap default version',
    })
  }
}

async function resolveActiveVersion(orgId: string, capabilityType: EvolutionCapabilityType): Promise<string | null> {
  const latestRelease = await repo.findLatestReleaseByOrgAndType(orgId, capabilityType)
  if (latestRelease?.to_version) return latestRelease.to_version
  const versions = await repo.listVersions(orgId, capabilityType, 1)
  return versions[0]?.version ?? null
}

export async function getActiveCapabilities(orgId = 'local', userId?: string): Promise<EvolutionCapabilityDoc[]> {
  await ensureBootstrap(orgId, userId)
  const [latestVersions, latestReleases] = await Promise.all([
    repo.listLatestVersionsByOrg(orgId),
    repo.listLatestReleasesByOrg(orgId),
  ])
  const latestVersionByType = new Map(latestVersions.map((row) => [row.capability_type, row]))
  const latestReleaseByType = new Map(latestReleases.map((row) => [row.capability_type, row]))
  const docs: EvolutionCapabilityDoc[] = []
  for (const capabilityType of CAPABILITY_TYPES) {
      const released = latestReleaseByType.get(capabilityType)
      if (released) {
      const releasedVersion = await repo.findVersion(orgId, capabilityType, released.to_version)
      if (releasedVersion) { docs.push(rowToDoc(releasedVersion)); continue }
    }
    const fallback = latestVersionByType.get(capabilityType)
    if (fallback) docs.push(rowToDoc(fallback))
  }
  return docs
}

export async function getCapabilityVersions(
  orgId: string,
  capabilityTypeInput: string,
  limit = 20
): Promise<EvolutionCapabilityDoc[]> {
  const capabilityType = normalizeType(capabilityTypeInput)
  const rows = await repo.listVersions(orgId, capabilityType, limit)
  return rows.map(rowToDoc)
}

export async function updateCapability(
  orgId: string,
  userId: string,
  capabilityTypeInput: string,
  content: string,
  changeNote?: string
): Promise<EvolutionCapabilityDoc> {
  const capabilityType = normalizeType(capabilityTypeInput)
  await ensureBootstrap(orgId, userId)
  const versions = await repo.listVersions(orgId, capabilityType, 1)
  const currentActiveVersion = await resolveActiveVersion(orgId, capabilityType)
  const nextVersion = toVersionLabel(toVersionNumber(versions[0]?.version) + 1)
  const created = await repo.createVersion({
    orgId, capabilityType, version: nextVersion, content, checksum: sha256(content), createdBy: userId,
  })
  await repo.createRelease({
    orgId, capabilityType, fromVersion: currentActiveVersion, toVersion: created.version,
    action: 'switch_version', operatorId: userId, changeNote: changeNote || 'edited via evolution center',
  })
  return rowToDoc(created)
}

export async function switchCapabilityVersion(
  orgId: string,
  userId: string,
  capabilityTypeInput: string,
  targetVersion: string,
  reason?: string
): Promise<EvolutionCapabilityDoc> {
  const capabilityType = normalizeType(capabilityTypeInput)
  await ensureBootstrap(orgId, userId)
  const target = await repo.findVersion(orgId, capabilityType, targetVersion)
  if (!target) throw createError(RESOURCE_NOT_FOUND, `Version not found: ${targetVersion}`)
  const currentVersion = await resolveActiveVersion(orgId, capabilityType)
  const action = toVersionNumber(target.version) < toVersionNumber(currentVersion)
    ? 'rollback_version'
    : 'switch_version'
  await repo.createRelease({
    orgId, capabilityType, fromVersion: currentVersion, toVersion: target.version,
    action, operatorId: userId, changeNote: reason || `switch to ${targetVersion}`,
  })
  return rowToDoc(target)
}

export function buildCapabilityInjectionBlock(docs: EvolutionCapabilityDoc[]): string {
  const byType = new Map(docs.map((d) => [d.capabilityType, d]))
  const sections: string[] = []
  for (const type of ['mind', 'guard', 'spine', 'hands', 'reflex'] as EvolutionCapabilityType[]) {
    const content = byType.get(type)?.content?.trim() || ''
    if (!content) continue
    sections.push(`<capability_${type}>`)
    sections.push(content)
    sections.push(`</capability_${type}>`)
  }
  return sections.join('\n')
}
