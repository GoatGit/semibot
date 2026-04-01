/**
 * Context Policy Repository — 本地文件存储代理
 */

import * as local from '../lib/context-policy-local-store'

export type { ContextPolicyDocType, LocalContextPolicyDocRow as ContextPolicyDocRow } from '../lib/context-policy-local-store'

export async function listLatestApprovedByOrg(_orgId?: string) {
  return local.localListLatestApprovedByOrg()
}

export async function findLatestApprovedByOrgAndType(_orgId: string, docType: local.ContextPolicyDocType) {
  return local.localFindLatestApprovedByOrgAndType(docType)
}

export async function listByOrgAndType(_orgId: string, docType: local.ContextPolicyDocType, limit = 20) {
  return local.localListByOrgAndType(docType, limit)
}

export async function createApprovedVersion(params: {
  orgId?: string
  docType: local.ContextPolicyDocType
  content: string
  reviewedBy?: string
  changeNote?: string
}) {
  return local.localCreateApprovedVersion(params)
}

export async function findByOrgTypeAndVersion(_orgId: string, docType: local.ContextPolicyDocType, version: string) {
  return local.localFindByOrgTypeAndVersion(docType, version)
}
