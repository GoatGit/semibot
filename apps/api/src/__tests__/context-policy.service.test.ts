import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRepo = {
  listLatestApprovedByOrg: vi.fn(),
  listByOrgAndType: vi.fn(),
  createApprovedVersion: vi.fn(),
  findByOrgTypeAndVersion: vi.fn(),
}

vi.mock('../repositories/context-policy.repository', () => mockRepo)

describe('context-policy.service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('getActivePolicies should fill missing doc types with default v0 payload', async () => {
    mockRepo.listLatestApprovedByOrg.mockResolvedValue([
      {
        id: 'doc-gene-1',
        org_id: 'org-1',
        doc_type: 'gene',
        version: 'v2',
        status: 'approved',
        content: 'gene policy',
        source_candidate_id: null,
        change_note: null,
        last_reviewed_by: null,
        last_reviewed_at: null,
        created_at: '2026-03-01T00:00:00.000Z',
        updated_at: '2026-03-01T00:00:00.000Z',
        deleted_at: null,
        deleted_by: null,
      },
    ])

    const svc = await import('../services/context-policy.service')
    const result = await svc.getActivePolicies('org-1')

    expect(result).toHaveLength(3)
    expect(result.find((item) => item.docType === 'gene')).toMatchObject({
      version: 'v2',
      content: 'gene policy',
    })
    expect(result.find((item) => item.docType === 'agents')).toMatchObject({
      version: 'v0',
      content: expect.stringContaining('Agent 选择策略'),
    })
    expect(result.find((item) => item.docType === 'tools')).toMatchObject({
      version: 'v0',
      content: expect.stringContaining('Tool 使用策略'),
    })
  })

  it('getActivePolicies should return defaults when table is missing', async () => {
    mockRepo.listLatestApprovedByOrg.mockRejectedValue({
      code: '42P01',
      message: 'relation "context_policy_docs" does not exist',
    })
    const svc = await import('../services/context-policy.service')
    const result = await svc.getActivePolicies('org-1')
    expect(result).toHaveLength(3)
    expect(result[0].content.length).toBeGreaterThan(10)
  })

  it('updatePolicy should create approved version and map response', async () => {
    mockRepo.createApprovedVersion.mockResolvedValue({
      id: 'doc-tools-3',
      org_id: 'org-1',
      doc_type: 'tools',
      version: 'v3',
      status: 'approved',
      content: 'tools policy v3',
      source_candidate_id: null,
      change_note: 'updated',
      last_reviewed_by: 'user-1',
      last_reviewed_at: '2026-03-02T00:00:00.000Z',
      created_at: '2026-03-02T00:00:00.000Z',
      updated_at: '2026-03-02T00:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    const svc = await import('../services/context-policy.service')
    const result = await svc.updatePolicy('org-1', 'user-1', 'tools', 'tools policy v3', 'updated')

    expect(mockRepo.createApprovedVersion).toHaveBeenCalledWith({
      orgId: 'org-1',
      docType: 'tools',
      content: 'tools policy v3',
      reviewedBy: 'user-1',
      changeNote: 'updated',
    })
    expect(result).toMatchObject({
      docType: 'tools',
      version: 'v3',
      content: 'tools policy v3',
      changeNote: 'updated',
    })
  })

  it('buildPolicyInjectionBlock should include all tagged sections', async () => {
    const svc = await import('../services/context-policy.service')
    const block = svc.buildPolicyInjectionBlock([
      {
        id: '1',
        docType: 'gene',
        version: 'v1',
        status: 'approved',
        content: 'GENE body',
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        id: '2',
        docType: 'agents',
        version: 'v1',
        status: 'approved',
        content: '',
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
      {
        id: '3',
        docType: 'tools',
        version: 'v1',
        status: 'approved',
        content: 'TOOLS body',
        updatedAt: '2026-03-02T00:00:00.000Z',
      },
    ])

    expect(block).toContain('<policy_gene>')
    expect(block).toContain('GENE body')
    expect(block).toContain('<policy_agents>')
    expect(block).toContain('No agents policy configured.')
    expect(block).toContain('<policy_tools>')
    expect(block).toContain('TOOLS body')
  })

  it('rollbackPolicy should create new approved version from target version content', async () => {
    mockRepo.findByOrgTypeAndVersion.mockResolvedValue({
      id: 'doc-agents-v2',
      org_id: 'org-1',
      doc_type: 'agents',
      version: 'v2',
      status: 'approved',
      content: 'agents policy v2',
      source_candidate_id: null,
      change_note: null,
      last_reviewed_by: null,
      last_reviewed_at: null,
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-01T00:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })
    mockRepo.createApprovedVersion.mockResolvedValue({
      id: 'doc-agents-v3',
      org_id: 'org-1',
      doc_type: 'agents',
      version: 'v3',
      status: 'approved',
      content: 'agents policy v2',
      source_candidate_id: null,
      change_note: 'rollback to v2',
      last_reviewed_by: 'user-1',
      last_reviewed_at: '2026-03-02T00:00:00.000Z',
      created_at: '2026-03-02T00:00:00.000Z',
      updated_at: '2026-03-02T00:00:00.000Z',
      deleted_at: null,
      deleted_by: null,
    })

    const svc = await import('../services/context-policy.service')
    const result = await svc.rollbackPolicy('org-1', 'user-1', 'agents', 'v2')

    expect(mockRepo.findByOrgTypeAndVersion).toHaveBeenCalledWith('org-1', 'agents', 'v2')
    expect(mockRepo.createApprovedVersion).toHaveBeenCalledWith({
      orgId: 'org-1',
      docType: 'agents',
      content: 'agents policy v2',
      reviewedBy: 'user-1',
      changeNote: 'rollback to v2',
    })
    expect(result).toMatchObject({
      docType: 'agents',
      version: 'v3',
      content: 'agents policy v2',
    })
  })

  it('rollbackPolicy should throw when target version does not exist', async () => {
    mockRepo.findByOrgTypeAndVersion.mockResolvedValue(null)
    const svc = await import('../services/context-policy.service')

    await expect(svc.rollbackPolicy('org-1', 'user-1', 'agents', 'v999')).rejects.toMatchObject({
      message: expect.stringContaining('Version not found'),
    })
  })

  it('updatePolicy should reject unsupported doc type', async () => {
    const svc = await import('../services/context-policy.service')

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      svc.updatePolicy('org-1', 'user-1', 'unknown' as any, 'text')
    ).rejects.toBeTruthy()
  })

  it('updatePolicy should throw migration hint when table is missing', async () => {
    mockRepo.createApprovedVersion.mockRejectedValue({
      code: '42P01',
      message: 'relation "context_policy_docs" does not exist',
    })
    const svc = await import('../services/context-policy.service')
    await expect(
      svc.updatePolicy('org-1', 'user-1', 'tools', 'x')
    ).rejects.toMatchObject({
      message: expect.stringContaining('run database migrations'),
    })
  })
})
