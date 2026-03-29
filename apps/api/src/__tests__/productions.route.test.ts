import path from 'path'
import fs from 'fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('productions route', () => {
  const originalDbPath = process.env.SEMIBOT_DB_PATH
  const originalArtifactsRoot = process.env.SEMIBOT_ARTIFACTS_ROOT
  const testDbPath = path.join('/tmp', 'semibot-api-productions-test.sqlite')
  const testArtifactsRoot = path.join('/tmp', 'semibot-api-productions-artifacts')

  beforeEach(() => {
    process.env.SEMIBOT_ENABLE_AUTH = 'false'
    process.env.SEMIBOT_DB_PATH = testDbPath
    process.env.SEMIBOT_ARTIFACTS_ROOT = testArtifactsRoot
    try {
      fs.rmSync(testDbPath, { force: true })
    } catch {}
    try {
      fs.rmSync(testArtifactsRoot, { recursive: true, force: true })
    } catch {}
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.SEMIBOT_ENABLE_AUTH
    if (originalDbPath) process.env.SEMIBOT_DB_PATH = originalDbPath
    else delete process.env.SEMIBOT_DB_PATH
    if (originalArtifactsRoot) process.env.SEMIBOT_ARTIFACTS_ROOT = originalArtifactsRoot
    else delete process.env.SEMIBOT_ARTIFACTS_ROOT
  })

  it('creates and loads a production detail with stages and tasks', async () => {
    const productionService = await import('../services/production.service')
    const name = `APS Test ${Date.now()}`
    const detail = await productionService.createProduction(
      {
        name,
        goal: 'Generate a long-form production deliverable.',
        config: {
          autoStart: false,
        },
      },
      'test-user'
    )
    expect(detail.production.status).toBe('planned')
    expect(detail.stages.length).toBe(1)
    expect(detail.tasks.length).toBe(1)

    const loaded = await productionService.getProductionDetail(detail.production.id)
    expect(loaded.production.name).toBe(name)
    expect(loaded.stages.length).toBe(1)
    expect(loaded.tasks.length).toBe(1)
    expect(loaded.events.some((event) => event.eventType === 'production.created')).toBe(true)
  })

  it('creates a revision task after review requests changes', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')
    const productionEngine = await import('../services/production-engine.service')
    const sessionService = await import('../services/session.service')
    const agentService = await import('../services/agent.service')

    const detail = await productionService.createProduction(
      {
        name: `APS Review ${Date.now()}`,
        goal: 'Create a reviewed deliverable.',
        config: {
          autoStart: false,
          defaultAgentId: '00000000-0000-0000-0000-000000000001',
        },
        plan: {
          schemaVersion: '1',
          stages: [
            {
              key: 'stage-review',
              title: 'Review Stage',
              sequence: 1,
              tasks: [
                {
                  key: 'task-review',
                  role: 'writer',
                  kind: 'generation',
                  goal: 'Draft the first version.',
                  reviewPolicy: {
                    required: true,
                    reviewerRole: 'editor',
                    reviewerType: 'human',
                  },
                  outputContract: [
                    {
                      artifactKey: 'draft',
                      artifactType: 'markdown',
                      schemaVersion: '1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      'test-user'
    )

    const sourceTask = detail.tasks[0]
    await productionService.activateProduction(detail.production.id)
    const sourceClaim = await productionRepo.claimNextRunnableTask(detail.production.id, 'test-source-worker')
    expect(sourceClaim?.task.id).toBe(sourceTask.id)
    await productionRepo.startAttempt(sourceClaim!.attempt.id, { schemaVersion: '1.0', source: 'test' })
    await productionRepo.completeAttempt({
      taskAttemptId: sourceClaim!.attempt.id,
      success: true,
      outputResult: {
        schemaVersion: '1.0',
        status: 'completed',
        artifacts: [],
        usage: {},
      },
      usage: {},
    })
    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# draft',
      createdByTaskId: sourceTask.id,
      createdByAttemptId: sourceClaim!.attempt.id,
    })
    const reviewJobs = await productionRepo.createReviewJobsForTask(sourceTask, sourceClaim!.attempt.id, [artifact])
    expect(reviewJobs.length).toBe(1)

    const reviewResult = await productionService.submitReviewDecision({
      reviewJobId: reviewJobs[0].id,
      decision: 'request_revision',
      findings: ['opening is weak'],
      revisionRequest: {
        mustFix: ['Strengthen the opening'],
        shouldFix: ['Clarify the protagonist goal'],
      },
    })

    expect(reviewResult.reviewDecision.decision).toBe('request_revision')
    expect(reviewResult.stageGate?.decision).toBe('request_revision')

    const loaded = await productionService.getProductionDetail(detail.production.id)
    const revisionTask = loaded.tasks.find((task) => task.kind === 'revision')
    expect(revisionTask).toBeTruthy()
    expect((revisionTask?.executionPolicy as Record<string, unknown>)?.revisionContext).toBeTruthy()

    vi.spyOn(agentService, 'getAgent').mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Writer',
      systemPrompt: 'write',
      description: '',
      config: {
        model: 'kimi-k2.5',
        temperature: 0.2,
        maxTokens: 2048,
        timeoutSeconds: 60,
      },
      skills: [],
      subAgents: [],
      version: 1,
      isActive: true,
      isPublic: false,
      isSystem: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    vi.spyOn(agentService, 'resolveRuntimeAgentConfig').mockResolvedValue({
      model: 'kimi-k2.5',
      modelProviderKey: '',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutSeconds: 60,
      retryAttempts: 1,
      fallbackModel: '',
      fallbackProviderKey: '',
      modelRoles: undefined,
    })
    vi.spyOn(sessionService, 'createSession').mockResolvedValue({
      id: 'sess-revision',
      title: 'revision',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000001',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.createSession>>)
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      id: 'sess-revision',
      title: 'revision',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000001',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.getSession>>)
    vi.spyOn(sessionService, 'getSessionMessages').mockResolvedValue([
      {
        id: 'msg-revision',
        sessionId: 'sess-revision',
        role: 'assistant',
        content: '[[artifact:draft]]\n# revised draft',
        createdAt: new Date().toISOString(),
        metadata: {},
      } as Awaited<ReturnType<typeof sessionService.getSessionMessages>>[number],
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }))

    await productionEngine.dispatchNextTask(detail.production.id, 'test-worker')
    const reloaded = await productionService.getProductionDetail(detail.production.id)
    const revisionAttempt = reloaded.attempts
      .filter((attempt) => attempt.taskId === revisionTask?.id)
      .sort((a, b) => b.attemptNo - a.attemptNo)[0]
    expect(revisionAttempt?.inputEnvelope?.revisionContext).toEqual({
      reviewDecisionId: reviewResult.reviewDecision.id,
      priorArtifactVersionId: artifact.id,
      mustFix: ['Strengthen the opening'],
      shouldFix: ['Clarify the protagonist goal'],
    })
  })

  it('replans a production and supersedes old pending tasks', async () => {
    const productionService = await import('../services/production.service')

    const detail = await productionService.createProduction(
      {
        name: `APS Replan ${Date.now()}`,
        goal: 'Initial goal',
        config: {
          autoStart: false,
        },
      },
      'test-user'
    )

    const originalPlanId = detail.production.currentPlanId
    const originalTaskId = detail.tasks[0].id

    const replanned = await productionService.replanProduction(detail.production.id, {
      goal: 'Updated goal after replan',
      plan: {
        schemaVersion: '1',
        rationale: 'manual replan',
        stages: [
          {
            key: 'stage-replanned',
            title: 'Replanned Stage',
            sequence: 1,
            tasks: [
              {
                key: 'task-replanned',
                role: 'producer',
                kind: 'generation',
                goal: 'Deliver the updated plan output.',
                outputContract: [
                  {
                    artifactKey: 'replanned-output',
                    artifactType: 'markdown',
                    schemaVersion: '1',
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(replanned.production.currentPlanId).not.toBe(originalPlanId)
    expect(replanned.tasks.some((task) => task.key === 'task-replanned')).toBe(true)
    const oldTask = replanned.tasks.find((task) => task.id === originalTaskId)
    expect(oldTask?.status).toBe('failed')
    expect(oldTask?.failureReason).toBe('superseded')
    expect(replanned.events.some((event) => event.eventType === 'production.replanned')).toBe(true)

    const plans = await productionService.listProductionPlans(detail.production.id)
    expect(plans.length).toBeGreaterThanOrEqual(2)

    const graphSummary = await productionService.getProductionGraphSummary(detail.production.id)
    expect(graphSummary.stats.addedTasks).toBeGreaterThanOrEqual(1)
    expect(graphSummary.stats.supersededTasks).toBeGreaterThanOrEqual(1)
  })

  it('loads stages and artifact content through production service accessors', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')

    const detail = await productionService.createProduction(
      {
        name: `APS Artifact ${Date.now()}`,
        goal: 'Create an artifact and expose detailed read APIs.',
        config: {
          autoStart: false,
        },
      },
      'test-user'
    )

    const stage = await productionService.getProductionStage(detail.production.id, detail.stages[0].id)
    expect(stage.id).toBe(detail.stages[0].id)

    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# artifact body',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-artifact-${Date.now()}`,
    })

    const loadedArtifact = await productionService.getArtifact(detail.production.id, artifact.id)
    expect(loadedArtifact.id).toBe(artifact.id)

    const content = await productionService.getArtifactContent(detail.production.id, artifact.id)
    expect(content.artifact.id).toBe(artifact.id)
    expect(content.content).toContain('artifact body')
  })

  it('returns artifact lineage and diff against previous version', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')

    const detail = await productionService.createProduction(
      {
        name: `APS Artifact Diff ${Date.now()}`,
        goal: 'Compare artifact versions.',
        config: { autoStart: false },
      },
      'test-user',
    )

    const v1 = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# title\nline one',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-artifact-v1-${Date.now()}`,
    })
    const v2 = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# title\nline two',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-artifact-v2-${Date.now()}`,
      lineageRefs: [v1.id],
    })

    const lineage = await productionService.getArtifactLineage(detail.production.id, v2.id)
    expect(lineage.previous?.id).toBe(v1.id)
    expect(lineage.related.some((item) => item.id === v1.id)).toBe(true)

    const diff = await productionService.getArtifactDiff(detail.production.id, v2.id)
    expect(diff.baseArtifact?.id).toBe(v1.id)
    expect(diff.stats.changed).toBe(true)
    expect(diff.lines.some((line) => line.type === 'added' || line.type === 'removed')).toBe(true)
  })

  it('updates artifact summary and persists planner metadata on snapshots', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')

    const detail = await productionService.createProduction(
      {
        name: `APS Planner Meta ${Date.now()}`,
        goal: 'Persist planner metadata and artifact summary.',
        config: { autoStart: false },
      },
      'test-user',
    )

    const plans = await productionService.listProductionPlans(detail.production.id)
    expect(plans[0]?.plannerMetadata).toBeTruthy()
    expect(typeof plans[0]?.plannerMetadata?.plannerType).toBe('string')

    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# artifact with summary',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-summary-${Date.now()}`,
    })

    const updated = await productionService.updateArtifactSummary(detail.production.id, artifact.id, 'updated summary')
    expect(updated.summary).toBe('updated summary')
  })

  it('loads escalation detail after rejected review', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')

    const detail = await productionService.createProduction(
      {
        name: `APS Escalation ${Date.now()}`,
        goal: 'Trigger an escalation after review rejection.',
        config: {
          autoStart: false,
        },
        plan: {
          schemaVersion: '1',
          stages: [
            {
              key: 'stage-review',
              title: 'Review Stage',
              sequence: 1,
              tasks: [
                {
                  key: 'task-review',
                  role: 'writer',
                  kind: 'generation',
                  goal: 'Draft the version to be rejected.',
                  reviewPolicy: {
                    required: true,
                    reviewerRole: 'editor',
                    reviewerType: 'human',
                  },
                  outputContract: [
                    {
                      artifactKey: 'draft',
                      artifactType: 'markdown',
                      schemaVersion: '1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      'test-user'
    )

    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# rejected draft',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-escalation-${Date.now()}`,
    })
    const reviewJobs = await productionRepo.createReviewJobsForTask(detail.tasks[0], artifact.createdByAttemptId || 'attempt-fallback', [artifact])

    const reviewResult = await productionService.submitReviewDecision({
      reviewJobId: reviewJobs[0].id,
      decision: 'rejected',
      findings: ['fatal issue'],
    })

    expect(reviewResult.stageGate?.decision).toBe('escalate')

    const escalations = await productionService.listProductionEscalations(detail.production.id)
    expect(escalations.length).toBeGreaterThan(0)

    const escalation = await productionService.getProductionEscalation(detail.production.id, escalations[0].id)
    expect(escalation.id).toBe(escalations[0].id)
    expect(escalation.reasonCode).toBeTruthy()
  })

  it('aggregates open review and escalation inbox items across productions', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')

    const detail = await productionService.createProduction(
      {
        name: `APS Inbox ${Date.now()}`,
        goal: 'Populate cross-production inbox items.',
        config: { autoStart: false },
        plan: {
          schemaVersion: '1',
          stages: [
            {
              key: 'stage-main',
              title: 'Main',
              sequence: 1,
              tasks: [
                {
                  key: 'task-main',
                  role: 'writer',
                  kind: 'generation',
                  goal: 'Create a reviewed artifact.',
                  reviewPolicy: {
                    required: true,
                    reviewerRole: 'editor',
                    reviewerType: 'human',
                  },
                  outputContract: [
                    {
                      artifactKey: 'draft',
                      artifactType: 'markdown',
                      schemaVersion: '1',
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      'test-user'
    )

    const attemptId = `attempt-inbox-${Date.now()}`
    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# inbox draft',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: attemptId,
    })
    const reviewJobs = await productionRepo.createReviewJobsForTask(detail.tasks[0], attemptId, [artifact])

    const reviewInbox = await productionService.listOpenReviewInbox()
    expect(reviewInbox.some((item) => item.reviewJob.id === reviewJobs[0].id)).toBe(true)

    await productionService.submitReviewDecision({
      reviewJobId: reviewJobs[0].id,
      decision: 'rejected',
      findings: ['fatal issue'],
    })

    const escalationInbox = await productionService.listOpenEscalationInbox()
    expect(escalationInbox.some((item) => item.production.id === detail.production.id)).toBe(true)

    const controlRoom = await productionService.getProductionControlRoom({})
    expect(controlRoom.totals.productions).toBeGreaterThan(0)
    expect(controlRoom.items.some((item) => item.production.id === detail.production.id)).toBe(true)

    const humanInbox = await productionService.listOpenHumanInbox()
    expect(humanInbox.some((item) => item.production.id === detail.production.id)).toBe(true)
  })

  it('evaluates stage gate policy before applying side effects', async () => {
    const { evaluateStageGatePolicy } = await import('../services/production-stage-gate-policy.service')

    const result = evaluateStageGatePolicy({
      production: {
        id: 'prod-1',
        orgId: 'org-1',
        name: 'Test',
        goal: 'Goal',
        constraints: {},
        config: {},
        status: 'active',
        currentPlanId: 'plan-1',
        currentStageId: 'stage-1',
        isPaused: false,
        createdBy: 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      stage: {
        id: 'stage-1',
        productionId: 'prod-1',
        planId: 'plan-1',
        key: 'stage-1',
        title: 'Stage',
        sequence: 1,
        status: 'active',
        reviewGateConfig: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      tasks: [
        {
          id: 'task-1',
          productionId: 'prod-1',
          planId: 'plan-1',
          stageId: 'stage-1',
          key: 'task-1',
          role: 'writer',
          kind: 'generation',
          status: 'done',
          priority: 100,
          goal: 'Draft',
          dependsOnTaskIds: [],
          inputArtifactRefs: [],
          outputContract: [],
          reviewPolicy: {},
          executionPolicy: {},
          budgetPolicy: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      reviewJobs: [
        {
          id: 'review-1',
          productionId: 'prod-1',
          taskId: 'task-1',
          taskAttemptId: 'attempt-1',
          artifactVersionId: 'artifact-1',
          reviewerRole: 'editor',
          reviewerType: 'human',
          status: 'completed',
          retryCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ],
      reviewDecisions: [
        {
          id: 'decision-1',
          reviewJobId: 'review-1',
          productionId: 'prod-1',
          taskId: 'task-1',
          taskAttemptId: 'attempt-1',
          reviewerRole: 'editor',
          reviewerType: 'human',
          decision: 'request_revision',
          findings: ['fix it'],
          revisionRequest: { mustFix: ['fix it'], shouldFix: [] },
          createdAt: new Date().toISOString(),
        },
      ],
    })

    expect(result.decision).toBe('request_revision')
    expect(result.reason).toBe('review_requested_revision')
    expect(result.counts.revisionRequested).toBe(1)
    expect(result.counts.pendingReviews).toBe(0)
    expect(result.reviewDecisionIds).toEqual(['decision-1'])
  })

  it('processes llm_auto review jobs through reviewer runtime adapter', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')
    const reviewerService = await import('../services/production-reviewer.service')
    const sessionService = await import('../services/session.service')
    const agentService = await import('../services/agent.service')

    vi.spyOn(agentService, 'getAgent').mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Reviewer',
      systemPrompt: 'review',
      description: '',
      config: {
        model: 'kimi-k2.5',
        temperature: 0.2,
        maxTokens: 2048,
        timeoutSeconds: 60,
      },
      skills: [],
      subAgents: [],
      version: 1,
      isActive: true,
      isPublic: false,
      isSystem: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    vi.spyOn(agentService, 'resolveRuntimeAgentConfig').mockResolvedValue({
      model: 'kimi-k2.5',
      modelProviderKey: '',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutSeconds: 60,
      retryAttempts: 1,
      fallbackModel: '',
      fallbackProviderKey: '',
      modelRoles: undefined,
    })
    vi.spyOn(sessionService, 'createSession').mockResolvedValue({
      id: 'sess-review',
      title: 'review',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000001',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.createSession>>)
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      id: 'sess-review',
      title: 'review',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000001',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.getSession>>)
    vi.spyOn(sessionService, 'getSessionMessages').mockResolvedValue([
      {
        id: 'msg-review',
        sessionId: 'sess-review',
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: '1.0',
          decision: 'approved',
          score: 0.91,
          findings: ['looks good'],
          revisionRequest: { mustFix: [], shouldFix: [] },
        }),
        createdAt: new Date().toISOString(),
        metadata: {},
      } as Awaited<ReturnType<typeof sessionService.getSessionMessages>>[number],
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }))

    const detail = await productionService.createProduction(
      {
        name: `APS Auto Review ${Date.now()}`,
        goal: 'Create an artifact that should be auto-reviewed.',
        config: {
          autoStart: false,
          defaultAgentId: '00000000-0000-0000-0000-000000000001',
        },
        plan: {
          schemaVersion: '1',
          stages: [
            {
              key: 'stage-main',
              title: 'Main',
              sequence: 1,
              tasks: [
                {
                  key: 'task-main',
                  role: 'writer',
                  kind: 'generation',
                  goal: 'Draft content.',
                  reviewPolicy: {
                    required: true,
                    reviewerRole: 'editor',
                    reviewerType: 'llm_auto',
                  },
                  outputContract: [
                    { artifactKey: 'draft', artifactType: 'markdown', schemaVersion: '1' },
                  ],
                },
              ],
            },
          ],
        },
      },
      'test-user'
    )

    const artifact = await productionRepo.registerArtifact({
      productionId: detail.production.id,
      artifactKey: 'draft',
      artifactType: 'markdown',
      schemaVersion: '1',
      content: '# auto review draft',
      createdByTaskId: detail.tasks[0].id,
      createdByAttemptId: `attempt-auto-review-${Date.now()}`,
    })
    const reviewJobs = await productionRepo.createReviewJobsForTask(detail.tasks[0], artifact.createdByAttemptId || 'attempt-fallback', [artifact])

    await reviewerService.processAutoReviewJobs(reviewJobs)

    const decisions = await productionService.listProductionReviewDecisions(detail.production.id)
    expect(decisions.some((decision) => decision.reviewJobId === reviewJobs[0].id && decision.decision === 'approved')).toBe(true)
  })

  it('accepts PlannerOutput envelope from runtime planner', async () => {
    const plannerService = await import('../services/production-planner.service')
    const sessionService = await import('../services/session.service')
    const agentService = await import('../services/agent.service')

    vi.spyOn(agentService, 'getAgent').mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000010',
      name: 'Planner',
      systemPrompt: 'plan',
      description: '',
      config: {
        model: 'kimi-k2.5',
        temperature: 0.2,
        maxTokens: 2048,
        timeoutSeconds: 60,
      },
      skills: [],
      subAgents: [],
      version: 1,
      isActive: true,
      isPublic: false,
      isSystem: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    vi.spyOn(agentService, 'resolveRuntimeAgentConfig').mockResolvedValue({
      model: 'kimi-k2.5',
      modelProviderKey: '',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutSeconds: 60,
      retryAttempts: 1,
      fallbackModel: '',
      fallbackProviderKey: '',
      modelRoles: undefined,
    })
    vi.spyOn(sessionService, 'createSession').mockResolvedValue({
      id: 'sess-plan',
      title: 'plan',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000010',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.createSession>>)
    vi.spyOn(sessionService, 'getSession').mockResolvedValue({
      id: 'sess-plan',
      title: 'plan',
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000010',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.getSession>>)
    vi.spyOn(sessionService, 'getSessionMessages').mockResolvedValue([
      {
        id: 'msg-plan',
        sessionId: 'sess-plan',
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: '1.0',
          planMode: 'initial',
          rationale: 'runtime planner output',
          plan: {
            schemaVersion: '1',
            rationale: 'runtime plan',
            stages: [
              {
                key: 'stage-runtime',
                title: 'Runtime Stage',
                sequence: 1,
                tasks: [
                  {
                    key: 'task-runtime',
                    role: 'producer',
                    kind: 'generation',
                    goal: 'Produce output from runtime planner.',
                  },
                ],
              },
            ],
          },
        }),
        createdAt: new Date().toISOString(),
        metadata: {},
      } as Awaited<ReturnType<typeof sessionService.getSessionMessages>>[number],
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }))

    const plan = await plannerService.buildInitialPlan({
      name: `APS Runtime Planner ${Date.now()}`,
      goal: 'Use runtime planner',
      config: {
        plannerMode: 'runtime',
        defaultAgentId: '00000000-0000-0000-0000-000000000010',
      },
    })

    expect(plan.stages[0]?.key).toBe('stage-runtime')
    expect(plan.stages[0]?.tasks[0]?.key).toBe('task-runtime')
  })

  it('maps production event version and recovers expired attempts back to pending', async () => {
    const productionService = await import('../services/production.service')
    const productionRepo = await import('../repositories/production.repository')
    const lifecycleService = await import('../services/production-lifecycle.service')

    const detail = await productionService.createProduction(
      {
        name: `APS Recovery ${Date.now()}`,
        goal: 'Recover a stale attempt.',
        config: { autoStart: true },
      },
      'test-user',
    )

    const claim = await productionRepo.claimNextRunnableTask(detail.production.id, 'test-worker')
    expect(claim).toBeTruthy()
    expect(claim?.attempt.status).toBe('created')

    const recovered = await productionRepo.sweepExpiredAttempts({
      now: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      heartbeatTimeoutMs: 1000,
    })
    expect(recovered.length).toBeGreaterThanOrEqual(1)

    const reloadedTask = await productionService.getProductionTask(detail.production.id, claim!.task.id)
    expect(reloadedTask.status).toBe('pending')

    const events = await productionService.listProductionEvents(detail.production.id)
    const recoveredEvent = events.find((event) => event.eventType === 'attempt.recovered')
    expect(recoveredEvent?.eventVersion).toBe('1')

    const lifecycle = await lifecycleService.sweepApsLifecycle()
    expect(Array.isArray(lifecycle.resumedProductions)).toBe(true)
  })

  it('parses nested llm usage from runtime SSE payloads', async () => {
    const { consumeRuntimeSse } = await import('../services/production-runtime-client')

    const encoder = new TextEncoder()
    const frames = [
      'data: {"event":"llm.usage","data":{"type":"llm.usage","prompt_tokens":11,"completion_tokens":5,"total_tokens":16}}\n\n',
      'data: {"event":"done","status":"completed","final_response":"ok"}\n\n',
    ]
    const response = {
      body: {
        getReader: () => {
          let index = 0
          return {
            read: async () => {
              if (index >= frames.length) return { done: true, value: undefined }
              const value = encoder.encode(frames[index])
              index += 1
              return { done: false, value }
            },
            releaseLock: () => undefined,
          }
        },
      },
    } as Response

    const result = await consumeRuntimeSse(response)
    expect(result.finalResponse).toBe('ok')
    expect(result.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
    })
  })

  it('runs a pipeline end-to-end with auto review and completes the production', async () => {
    const productionService = await import('../services/production.service')
    const productionEngine = await import('../services/production-engine.service')
    const sessionService = await import('../services/session.service')
    const agentService = await import('../services/agent.service')

    vi.spyOn(agentService, 'getAgent').mockResolvedValue({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Pipeline Agent',
      systemPrompt: 'produce and review',
      description: '',
      config: {
        model: 'kimi-k2.5',
        temperature: 0.2,
        maxTokens: 2048,
        timeoutSeconds: 60,
      },
      skills: [],
      subAgents: [],
      version: 1,
      isActive: true,
      isPublic: false,
      isSystem: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    vi.spyOn(agentService, 'resolveRuntimeAgentConfig').mockResolvedValue({
      model: 'kimi-k2.5',
      modelProviderKey: '',
      temperature: 0.2,
      maxTokens: 2048,
      timeoutSeconds: 60,
      retryAttempts: 1,
      fallbackModel: '',
      fallbackProviderKey: '',
      modelRoles: undefined,
    })

    let sessionCount = 0
    vi.spyOn(sessionService, 'createSession').mockImplementation(async () => {
      sessionCount += 1
      return {
        id: `sess-${sessionCount}`,
        title: `sess-${sessionCount}`,
        userId: 'test',
        agentId: '00000000-0000-0000-0000-000000000001',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      } as Awaited<ReturnType<typeof sessionService.createSession>>
    })
    vi.spyOn(sessionService, 'getSession').mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      title: sessionId,
      userId: 'test',
      agentId: '00000000-0000-0000-0000-000000000001',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    } as Awaited<ReturnType<typeof sessionService.getSession>>))
    vi.spyOn(sessionService, 'getSessionMessages').mockImplementation(async (sessionId: string) => {
      if (sessionId === 'sess-1') {
        return [
          {
            id: 'msg-1',
            sessionId,
            role: 'assistant',
            content: '[[artifact:draft]]\n# final draft\nbody',
            createdAt: new Date().toISOString(),
            metadata: {},
          } as Awaited<ReturnType<typeof sessionService.getSessionMessages>>[number],
        ]
      }
      return [
        {
          id: 'msg-2',
          sessionId,
          role: 'assistant',
          content: JSON.stringify({
            schemaVersion: '1.0',
            decision: 'approved',
            score: 0.92,
            findings: ['ready'],
            revisionRequest: { mustFix: [], shouldFix: [] },
          }),
          createdAt: new Date().toISOString(),
          metadata: {},
        } as Awaited<ReturnType<typeof sessionService.getSessionMessages>>[number],
      ]
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => undefined,
        }),
      },
    }))

    const detail = await productionService.createProduction(
      {
        name: `APS Full Flow ${Date.now()}`,
        goal: 'Run one full pipeline with auto review.',
        config: {
          autoStart: false,
          defaultAgentId: '00000000-0000-0000-0000-000000000001',
        },
        plan: {
          schemaVersion: '1',
          stages: [
            {
              key: 'stage-main',
              title: 'Main',
              sequence: 1,
              reviewGateConfig: {
                approvalStrategy: 'weighted',
                minWeightedScore: 0.8,
              },
              tasks: [
                {
                  key: 'task-main',
                  role: 'writer',
                  kind: 'generation',
                  goal: 'Create one final draft.',
                  reviewPolicy: {
                    required: true,
                    reviewerRole: 'editor',
                    reviewerType: 'llm_auto',
                  },
                  outputContract: [
                    { artifactKey: 'draft', artifactType: 'markdown', schemaVersion: '1' },
                  ],
                },
              ],
            },
          ],
        },
      },
      'test-user',
    )

    await productionEngine.runProduction(detail.production.id)

    const reloaded = await productionService.getProductionDetail(detail.production.id)
    expect(reloaded.production.status).toBe('completed')
    expect(reloaded.stages[0]?.status).toBe('completed')
    expect(reloaded.artifacts.some((artifact) => artifact.artifactKey === 'draft')).toBe(true)
    expect(reloaded.reviewDecisions.some((decision) => decision.decision === 'approved')).toBe(true)
    expect(reloaded.events.some((event) => event.eventType === 'production.completed')).toBe(true)
  })
})
