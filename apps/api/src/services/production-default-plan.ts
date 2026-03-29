import type {
  CreateProductionInput,
  ProductionPlan,
  ProductionTaskDefinition,
} from '@semibot/shared-types'

export function buildDefaultMainTask(goal: string, defaultAgentId?: string): ProductionTaskDefinition {
  return {
    key: 'task-main',
    title: 'Generate primary deliverable',
    role: 'producer',
    kind: 'generation',
    goal,
    outputContract: [
      {
        artifactKey: 'primary-deliverable',
        artifactType: 'markdown',
        schemaVersion: '1',
        required: true,
      },
    ],
    executionPolicy: defaultAgentId ? { agentId: defaultAgentId } : {},
    reviewPolicy: {
      required: false,
    },
  }
}

export function buildDefaultPlan(
  goal: string,
  defaultAgentId?: string,
  budget?: Record<string, unknown>,
  rationale?: string,
): ProductionPlan {
  return {
    schemaVersion: '1',
    rationale: rationale || 'Default single-stage production plan',
    stages: [
      {
        key: 'stage-main',
        title: 'Main Delivery',
        sequence: 1,
        exitCriteria: 'Primary deliverable produced',
        tasks: [
          {
            ...buildDefaultMainTask(goal, defaultAgentId),
            budgetPolicy: budget || {},
          },
        ],
      },
    ],
  }
}

export function defaultPlanForInput(input: CreateProductionInput): ProductionPlan {
  return buildDefaultPlan(
    input.goal,
    input.config?.defaultAgentId,
    (input.constraints?.budget as Record<string, unknown> | undefined) || {},
    'Default single-stage production plan',
  )
}
