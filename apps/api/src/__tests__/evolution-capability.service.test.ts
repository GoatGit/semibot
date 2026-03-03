import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRepo = {
  listLatestVersionsByOrg: vi.fn(),
  listLatestReleasesByOrg: vi.fn(),
  findLatestReleaseByOrgAndType: vi.fn(),
  findVersion: vi.fn(),
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  createRelease: vi.fn(),
}

vi.mock('../repositories/evolution-capability.repository', () => mockRepo)

describe('evolution-capability.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('updateCapability creates next version and release record', async () => {
    mockRepo.listLatestVersionsByOrg.mockResolvedValue([
      { capability_type: 'hands', version: 'v2' },
      { capability_type: 'reflex', version: 'v1' },
      { capability_type: 'spine', version: 'v1' },
      { capability_type: 'guard', version: 'v1' },
      { capability_type: 'mind', version: 'v1' },
    ])
    mockRepo.listVersions.mockResolvedValue([
      {
        id: 'row-1',
        org_id: 'org-1',
        capability_type: 'hands',
        version: 'v2',
        content_text: 'old content',
        checksum: 'x',
        created_by: null,
        created_at: '2026-03-03T00:00:00.000Z',
      },
    ])
    mockRepo.findLatestReleaseByOrgAndType.mockResolvedValue({
      to_version: 'v2',
    })
    mockRepo.createVersion.mockResolvedValue({
      id: 'row-2',
      org_id: 'org-1',
      capability_type: 'hands',
      version: 'v3',
      content_text: 'new content',
      checksum: 'abc',
      created_by: 'user-1',
      created_at: '2026-03-03T01:00:00.000Z',
    })

    const svc = await import('../services/evolution-capability.service')
    const result = await svc.updateCapability('org-1', 'user-1', 'hands', 'new content', 'edit')

    expect(mockRepo.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        capabilityType: 'hands',
        version: 'v3',
        content: 'new content',
        createdBy: 'user-1',
      })
    )
    expect(mockRepo.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        capabilityType: 'hands',
        fromVersion: 'v2',
        toVersion: 'v3',
        action: 'switch_version',
      })
    )
    expect(result).toMatchObject({
      capabilityType: 'hands',
      version: 'v3',
      content: 'new content',
    })
  })

  it('switchCapabilityVersion writes rollback action when switching to lower version', async () => {
    mockRepo.listLatestVersionsByOrg.mockResolvedValue([
      { capability_type: 'hands', version: 'v3' },
      { capability_type: 'reflex', version: 'v1' },
      { capability_type: 'spine', version: 'v1' },
      { capability_type: 'guard', version: 'v1' },
      { capability_type: 'mind', version: 'v1' },
    ])
    mockRepo.findVersion.mockResolvedValue({
      id: 'row-target',
      org_id: 'org-1',
      capability_type: 'hands',
      version: 'v1',
      content_text: 'target content',
      checksum: 'abc',
      created_by: null,
      created_at: '2026-03-01T00:00:00.000Z',
    })
    mockRepo.findLatestReleaseByOrgAndType.mockResolvedValue({
      to_version: 'v3',
    })

    const svc = await import('../services/evolution-capability.service')
    const result = await svc.switchCapabilityVersion('org-1', 'user-1', 'hands', 'v1', 'manual rollback')

    expect(mockRepo.createRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityType: 'hands',
        fromVersion: 'v3',
        toVersion: 'v1',
        action: 'rollback_version',
      })
    )
    expect(result).toMatchObject({
      capabilityType: 'hands',
      version: 'v1',
      content: 'target content',
    })
  })
})
