/**
 * APS Productions API
 */

import { Router, type Response } from 'express'
import { z } from 'zod'
import { authenticate, requirePermission, type AuthRequest } from '../../middleware/auth'
import { asyncHandler, validate } from '../../middleware/errorHandler'
import { combinedRateLimit } from '../../middleware/rateLimit'
import * as productionService from '../../services/production.service'
import * as productionEngine from '../../services/production-engine.service'
import { sweepApsLifecycle } from '../../services/production-lifecycle.service'

const router: Router = Router()

const artifactRefSchema = z.object({
  artifactKey: z.string().optional(),
  artifactVersionId: z.string().uuid().optional(),
  required: z.boolean().optional(),
  purpose: z.string().optional(),
})

const outputArtifactContractSchema = z.object({
  artifactKey: z.string().min(1),
  artifactType: z.string().min(1),
  schemaVersion: z.string().min(1),
  required: z.boolean().optional(),
})

const taskSchema = z.object({
  key: z.string().min(1),
  title: z.string().optional(),
  role: z.string().min(1),
  kind: z.enum(['generation', 'revision', 'review', 'analysis', 'aggregation']),
  goal: z.string().min(1),
  dependsOnTaskKeys: z.array(z.string()).optional(),
  inputArtifactRefs: z.array(artifactRefSchema).optional(),
  outputContract: z.array(outputArtifactContractSchema).optional(),
  reviewPolicy: z.object({
    required: z.boolean().optional(),
    reviewerRole: z.string().optional(),
    reviewerType: z.enum(['llm_auto', 'human']).optional(),
  }).optional(),
  executionPolicy: z.record(z.unknown()).optional(),
  budgetPolicy: z.record(z.unknown()).optional(),
  priority: z.number().int().optional(),
})

const stageSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  sequence: z.number().int().min(1),
  exitCriteria: z.string().optional(),
  reviewGateConfig: z.record(z.unknown()).optional(),
  tasks: z.array(taskSchema).min(1),
})

const createProductionSchema = z.object({
  name: z.string().min(1).max(120),
  goal: z.string().min(1),
  constraints: z.record(z.unknown()).optional(),
  config: z.object({
    defaultAgentId: z.string().uuid().optional(),
    autoStart: z.boolean().optional(),
    autoDispatch: z.boolean().optional(),
  }).catchall(z.unknown()).optional(),
  plan: z.object({
    schemaVersion: z.string().min(1),
    rationale: z.string().optional(),
    stages: z.array(stageSchema).min(1),
  }).optional(),
})

const replanProductionSchema = z.object({
  goal: z.string().min(1).optional(),
  constraints: z.record(z.unknown()).optional(),
  config: z.record(z.unknown()).optional(),
  plan: z.object({
    schemaVersion: z.string().min(1),
    rationale: z.string().optional(),
    stages: z.array(stageSchema).min(1),
  }).optional(),
})

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  search: z.string().max(120).optional(),
  status: z.enum(['planned', 'active', 'paused', 'awaiting_human', 'completed', 'failed', 'cancelled']).optional(),
})

const eventsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(500).optional(),
})

const artifactDiffQuerySchema = z.object({
  baseArtifactVersionId: z.string().uuid().optional(),
})

const updateArtifactSummarySchema = z.object({
  summary: z.string().max(4000),
})

const graphSummaryQuerySchema = z.object({
  basePlanId: z.string().uuid().optional(),
})

const reviewDecisionSchema = z.object({
  decision: z.enum(['approved', 'request_revision', 'rejected']),
  score: z.number().min(0).max(1).optional(),
  findings: z.array(z.string()).optional(),
  revisionRequest: z.object({
    mustFix: z.array(z.string()).default([]),
    shouldFix: z.array(z.string()).optional(),
  }).optional(),
})

const resolveEscalationSchema = z.object({
  decisionType: z.enum(['resume', 'approve_override', 'reject', 'cancel']),
  payload: z.record(z.unknown()).optional(),
})

router.get(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await productionService.listProductions(req.query as { page?: number; limit?: number; search?: string; status?: never })
    res.json({ success: true, ...result })
  })
)

router.get(
  '/control-room',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const summary = await productionService.getProductionControlRoom(req.query as {
      page?: number
      limit?: number
      search?: string
      status?: never
    })
    res.json({ success: true, data: summary })
  })
)

router.get(
  '/inbox/human',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const items = await productionService.listOpenHumanInbox(100)
    res.json({ success: true, data: items })
  })
)

router.get(
  '/inbox/reviews',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const items = await productionService.listOpenReviewInbox(50)
    res.json({ success: true, data: items })
  })
)

router.get(
  '/inbox/escalations',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const items = await productionService.listOpenEscalationInbox(50)
    res.json({ success: true, data: items })
  })
)

router.post(
  '/lifecycle/sweep',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (_req: AuthRequest, res: Response) => {
    const result = await sweepApsLifecycle()
    res.json({ success: true, data: result })
  })
)

router.post(
  '/',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(createProductionSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const detail = await productionService.createProduction(req.body, req.user?.userId || 'local')
    if (detail.production.status === 'active' && detail.production.config.autoDispatch) {
      void productionEngine.runProductionGuarded(detail.production.id).catch(() => undefined)
    }
    res.status(201).json({ success: true, data: detail })
  })
)

router.get(
  '/:id',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const detail = await productionService.getProductionDetail(req.params.id)
    res.json({ success: true, data: detail })
  })
)

router.post(
  '/:id/activate',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const production = await productionService.activateProduction(req.params.id)
    void productionEngine.runProductionGuarded(req.params.id).catch(() => undefined)
    res.json({ success: true, data: production })
  })
)

router.post(
  '/:id/pause',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const production = await productionService.pauseProduction(req.params.id)
    res.json({ success: true, data: production })
  })
)

router.post(
  '/:id/replan',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(replanProductionSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const detail = await productionService.replanProduction(req.params.id, req.body)
    res.json({ success: true, data: detail })
  })
)

router.post(
  '/:id/run',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await productionService.activateProduction(req.params.id)
    void productionEngine.runProductionGuarded(req.params.id).catch(() => undefined)
    res.status(202).json({ success: true, data: { accepted: true } })
  })
)

router.post(
  '/:id/dispatch',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await productionEngine.dispatchNextTask(req.params.id, req.user?.userId || 'aps-manual')
    res.json({ success: true, data: result })
  })
)

router.get(
  '/:id/stages',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const stages = await productionService.listProductionStages(req.params.id)
    res.json({ success: true, data: stages })
  })
)

router.get(
  '/:id/plans',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const plans = await productionService.listProductionPlans(req.params.id)
    res.json({ success: true, data: plans })
  })
)

router.get(
  '/:id/graph-summary',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(graphSummaryQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const summary = await productionService.getProductionGraphSummary(
      req.params.id,
      typeof req.query.basePlanId === 'string' ? req.query.basePlanId : undefined,
    )
    res.json({ success: true, data: summary })
  })
)

router.get(
  '/:id/stages/:stageId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const stage = await productionService.getProductionStage(req.params.id, req.params.stageId)
    res.json({ success: true, data: stage })
  })
)

router.get(
  '/:id/tasks',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const tasks = await productionService.listProductionTasks(req.params.id)
    res.json({ success: true, data: tasks })
  })
)

router.get(
  '/:id/tasks/:taskId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const task = await productionService.getProductionTask(req.params.id, req.params.taskId)
    res.json({ success: true, data: task })
  })
)

router.get(
  '/:id/attempts/:attemptId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const attempt = await productionService.getProductionAttempt(req.params.id, req.params.attemptId)
    res.json({ success: true, data: attempt })
  })
)

router.get(
  '/:id/artifacts',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const artifacts = await productionService.listProductionArtifacts(req.params.id)
    res.json({ success: true, data: artifacts })
  })
)

router.get(
  '/:id/artifacts/:artifactVersionId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const artifact = await productionService.getArtifact(req.params.id, req.params.artifactVersionId)
    res.json({ success: true, data: artifact })
  })
)

router.get(
  '/:id/artifacts/:artifactVersionId/content',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await productionService.getArtifactContent(req.params.id, req.params.artifactVersionId)
    res.json({ success: true, data: result })
  })
)

router.get(
  '/:id/artifacts/:artifactVersionId/lineage',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const lineage = await productionService.getArtifactLineage(req.params.id, req.params.artifactVersionId)
    res.json({ success: true, data: lineage })
  })
)

router.get(
  '/:id/artifacts/:artifactVersionId/diff',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(artifactDiffQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const diff = await productionService.getArtifactDiff(
      req.params.id,
      req.params.artifactVersionId,
      typeof req.query.baseArtifactVersionId === 'string' ? req.query.baseArtifactVersionId : undefined,
    )
    res.json({ success: true, data: diff })
  })
)

router.post(
  '/:id/artifacts/:artifactVersionId/summary',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(updateArtifactSummarySchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const artifact = await productionService.updateArtifactSummary(
      req.params.id,
      req.params.artifactVersionId,
      String(req.body.summary || ''),
    )
    res.json({ success: true, data: artifact })
  })
)

router.get(
  '/:id/review-jobs',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const reviewJobs = await productionService.listProductionReviewJobs(req.params.id)
    res.json({ success: true, data: reviewJobs })
  })
)

router.get(
  '/:id/reviews',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const reviews = await productionService.listProductionReviews(req.params.id)
    res.json({ success: true, data: reviews })
  })
)

router.get(
  '/:id/events',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  validate(eventsQuerySchema, 'query'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const events = await productionService.listProductionEvents(req.params.id, Number(req.query.limit || 200))
    res.json({ success: true, data: events })
  })
)

router.post(
  '/review-jobs/:reviewJobId/decision',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(reviewDecisionSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await productionService.submitReviewDecision({
      reviewJobId: req.params.reviewJobId,
      decision: req.body.decision,
      score: req.body.score,
      findings: req.body.findings,
      revisionRequest: req.body.revisionRequest,
    })
    res.json({ success: true, data: result })
  })
)

router.get(
  '/:id/escalations',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const escalations = await productionService.listProductionEscalations(req.params.id)
    res.json({ success: true, data: escalations })
  })
)

router.get(
  '/:id/escalations/:escalationId',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:read'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const escalation = await productionService.getProductionEscalation(req.params.id, req.params.escalationId)
    res.json({ success: true, data: escalation })
  })
)

router.post(
  '/:id/escalations/:escalationId/resolve',
  authenticate,
  combinedRateLimit,
  requirePermission('agents:write'),
  validate(resolveEscalationSchema, 'body'),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await productionService.resolveEscalation({
      productionId: req.params.id,
      escalationId: req.params.escalationId,
      decisionType: req.body.decisionType,
      payload: req.body.payload,
      decidedBy: req.user?.userId,
    })
    res.json({ success: true, data: result })
  })
)

export default router
