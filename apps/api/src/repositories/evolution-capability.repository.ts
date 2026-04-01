import * as local from '../lib/evolution-local-store'

export type EvolutionCapabilityType = local.EvolutionCapabilityType
export type CapabilityVersionRow = local.CapabilityVersionRow
export type CapabilityReleaseRow = local.CapabilityReleaseRow

export async function listLatestVersionsByOrg(_orgId?: string) {
  return local.localListLatestVersionsByOrg()
}

export async function listLatestReleasesByOrg(_orgId?: string) {
  return local.localListLatestReleasesByOrg()
}

export async function findLatestReleaseByOrgAndType(
  _orgId: string,
  capabilityType: local.EvolutionCapabilityType
) {
  return local.localFindLatestReleaseByOrgAndType(capabilityType)
}

export async function findVersion(
  _orgId: string,
  capabilityType: local.EvolutionCapabilityType,
  version: string
) {
  return local.localFindVersion(capabilityType, version)
}

export async function listVersions(
  _orgId: string,
  capabilityType: local.EvolutionCapabilityType,
  limit = 20
) {
  return local.localListVersions(capabilityType, limit)
}

export async function createVersion(params: {
  orgId?: string
  capabilityType: local.EvolutionCapabilityType
  version: string
  content: string
  checksum: string
  createdBy?: string
}) {
  return local.localCreateVersion(params)
}

export async function createRelease(params: {
  orgId?: string
  capabilityType: local.EvolutionCapabilityType
  fromVersion: string | null
  toVersion: string
  action: 'create_version' | 'switch_version' | 'rollback_version'
  operatorId?: string
  changeNote?: string
}) {
  return local.localCreateRelease(params)
}
