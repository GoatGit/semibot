import { z } from 'zod'
import type {
  OutputArtifactContract,
  ReviewerDecisionEnvelope,
  TypedResult,
  TypedResultArtifactRef,
} from '@semibot/shared-types'

const typedResultArtifactRefSchema = z.object({
  artifactKey: z.string().min(1),
  artifactType: z.string().min(1),
  artifactVersionId: z.string().optional(),
  storageUri: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
}) satisfies z.ZodType<TypedResultArtifactRef>

const typedResultSchema = z.object({
  schemaVersion: z.string().min(1),
  status: z.enum(['completed', 'failed']),
  text: z.string().optional(),
  artifacts: z.array(typedResultArtifactRefSchema),
  usage: z.record(z.unknown()),
  metrics: z.record(z.unknown()).optional(),
  failure: z.object({
    kind: z.string().min(1),
    detail: z.record(z.unknown()).optional(),
  }).optional(),
}) satisfies z.ZodType<TypedResult>

export function validateTypedResult(input: {
  result: TypedResult
  outputContracts: OutputArtifactContract[]
}): { ok: true; result: TypedResult } | {
  ok: false
  reason: string
  failure: NonNullable<TypedResult['failure']>
} {
  const parsed = typedResultSchema.safeParse(input.result)
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'typed_result_schema_invalid',
      failure: {
        kind: 'invalid_output_contract',
        detail: {
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      },
    }
  }

  const requiredKeys = input.outputContracts.filter((contract) => contract.required !== false).map((contract) => contract.artifactKey)
  const artifactKeys = new Set(parsed.data.artifacts.map((artifact) => artifact.artifactKey))
  const missingArtifactKeys = requiredKeys.filter((key) => !artifactKeys.has(key))
  if (missingArtifactKeys.length > 0) {
    return {
      ok: false,
      reason: 'typed_result_missing_required_artifacts',
      failure: {
        kind: 'missing_required_artifact',
        detail: { missingArtifactKeys },
      },
    }
  }

  if (!String(parsed.data.text || '').trim() && parsed.data.artifacts.length === 0) {
    return {
      ok: false,
      reason: 'typed_result_missing_output',
      failure: {
        kind: 'missing_output',
        detail: {},
      },
    }
  }

  return { ok: true, result: parsed.data }
}

export function buildTypedResultRepairReason(input: {
  reason: string
  outputContracts: OutputArtifactContract[]
  failure: NonNullable<TypedResult['failure']>
}): string {
  if (input.reason === 'typed_result_missing_required_artifacts') {
    const missing = Array.isArray(input.failure.detail?.missingArtifactKeys)
      ? input.failure.detail?.missingArtifactKeys.join(', ')
      : ''
    return `Your previous output missed required artifacts: ${missing}. Re-emit the deliverable using exact artifact markers for all required outputs.`
  }
  if (input.reason === 'typed_result_missing_output') {
    return 'Your previous output was empty. Re-emit the deliverable with actual content.'
  }
  return `Your previous output did not satisfy the TypedResult contract. Re-emit valid deliverable content for: ${input.outputContracts.map((contract) => contract.artifactKey).join(', ')}.`
}

const reviewerDecisionEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  decision: z.enum(['approved', 'request_revision', 'rejected']),
  score: z.number().min(0).max(1).optional(),
  findings: z.array(z.string()).default([]),
  revisionRequest: z.object({
    mustFix: z.array(z.string()).default([]),
    shouldFix: z.array(z.string()).optional(),
  }).optional(),
})

export function validateReviewerDecisionEnvelope(parsed: unknown): ReviewerDecisionEnvelope | null {
  const result = reviewerDecisionEnvelopeSchema.safeParse(parsed)
  if (!result.success) return null
  if (result.data.decision === 'request_revision' && result.data.revisionRequest?.mustFix.length === 0) {
    return null
  }
  return result.data
}
