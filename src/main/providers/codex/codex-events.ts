import { z } from 'zod'

import { reasoningEffortSchema } from '../../../shared/schemas'

const boundedId = z.string().trim().min(1).max(200)
const boundedText = z.string().max(200_000)

export const initializeResponseSchema = z.strictObject({
  userAgent: z.string().max(1_024),
  codexHome: z.string().max(32_768),
  platformFamily: z.string().max(100),
  platformOs: z.string().max(100)
})

const planTypeSchema = z.enum([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'business',
  'ent26',
  'enterprise_cbp_automation',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown'
])

export const accountReadResponseSchema = z.strictObject({
  account: z
    .discriminatedUnion('type', [
      z.strictObject({ type: z.literal('apiKey') }),
      z.strictObject({
        type: z.literal('chatgpt'),
        email: z.string().email().nullable(),
        planType: planTypeSchema
      }),
      z.strictObject({
        type: z.literal('amazonBedrock'),
        usesCodexManagedCredentials: z.boolean()
      })
    ])
    .nullable(),
  requiresOpenaiAuth: z.boolean()
})

export const loginStartResponseSchema = z.strictObject({
  type: z.literal('chatgpt'),
  loginId: boundedId,
  authUrl: z.string().max(8_192)
})

export const loginCompletedSchema = z.strictObject({
  loginId: boundedId.nullable(),
  success: z.boolean(),
  error: z.string().max(4_096).nullable(),
  onboardingEntrypoint: z.unknown().nullable()
})

export const cancelLoginResponseSchema = z.strictObject({
  status: z.enum(['canceled', 'notFound'])
})

export const emptyResponseSchema = z.strictObject({})

const reasoningOptionSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema,
  description: z.string().max(4_096)
})

export const codexModelSchema = z.strictObject({
  id: boundedId,
  model: boundedId,
  upgrade: boundedId.nullable(),
  upgradeInfo: z.unknown().nullable(),
  availabilityNux: z.unknown().nullable(),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(4_096),
  modelSpecialty: z.string().max(200).nullable(),
  hidden: z.boolean(),
  supportedReasoningEfforts: z.array(reasoningOptionSchema).max(7),
  defaultReasoningEffort: reasoningEffortSchema,
  inputModalities: z.array(z.enum(['text', 'image', 'audio'])).max(3),
  supportsPersonality: z.boolean(),
  additionalSpeedTiers: z.array(z.string().max(200)).max(20),
  serviceTiers: z.array(z.unknown()).max(20),
  defaultServiceTier: z.string().max(200).nullable(),
  isDefault: z.boolean()
})

export const modelListResponseSchema = z.strictObject({
  data: z.array(codexModelSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable()
})

export const threadStartResponseSchema = z.strictObject({
  thread: z.strictObject({
    id: boundedId,
    sessionId: boundedId,
    forkedFromId: boundedId.nullable(),
    parentThreadId: boundedId.nullable(),
    preview: z.string().max(10_000),
    ephemeral: z.literal(true),
    section: z.unknown().nullable(),
    sectionEnteredAt: z.number().finite().nullable(),
    modelProvider: z.string().max(200),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    recencyAt: z.number().finite().nullable(),
    status: z.unknown(),
    path: z.string().max(32_768).nullable(),
    cwd: z.string().max(32_768),
    cliVersion: z.string().max(200),
    source: z.unknown(),
    threadSource: z.unknown().nullable(),
    agentNickname: z.string().max(200).nullable(),
    agentRole: z.string().max(200).nullable(),
    gitInfo: z.unknown().nullable(),
    name: z.string().max(1_000).nullable(),
    turns: z.array(z.unknown()).max(100)
  }),
  model: boundedId,
  modelProvider: z.string().max(200),
  serviceTier: z.string().max(200).nullable(),
  cwd: z.string().max(32_768),
  instructionSources: z.array(z.string().max(32_768)).max(100),
  approvalPolicy: z.literal('never'),
  approvalsReviewer: z.unknown(),
  sandbox: z.strictObject({ type: z.literal('readOnly'), networkAccess: z.literal(false) }),
  reasoningEffort: z.string().nullable()
})

const turnStatusSchema = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
const turnSchema = z.strictObject({
  id: boundedId,
  items: z.array(z.unknown()).max(1_000),
  itemsView: z.enum(['notLoaded', 'summary', 'full']),
  status: turnStatusSchema,
  error: z
    .strictObject({
      message: z.string().max(4_096),
      codexErrorInfo: z.unknown().nullable(),
      additionalDetails: z.string().max(4_096).nullable()
    })
    .nullable(),
  startedAt: z.number().finite().nullable(),
  completedAt: z.number().finite().nullable(),
  durationMs: z.number().finite().nonnegative().nullable()
})

export const turnStartResponseSchema = z.strictObject({ turn: turnSchema })

export const agentMessageDeltaSchema = z.strictObject({
  threadId: boundedId,
  turnId: boundedId,
  itemId: boundedId,
  delta: boundedText
})

export const turnCompletedSchema = z.strictObject({
  threadId: boundedId,
  turn: turnSchema
})

export type CodexModel = z.output<typeof codexModelSchema>
export type LoginCompleted = z.output<typeof loginCompletedSchema>
export type AgentMessageDelta = z.output<typeof agentMessageDeltaSchema>
export type TurnCompleted = z.output<typeof turnCompletedSchema>

export const DEBATE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    speech: { type: 'string', minLength: 1, maxLength: 200_000 },
    status: { type: 'string', enum: ['continue', 'concede', 'agree'] }
  },
  required: ['speech', 'status'],
  additionalProperties: false
} as const
