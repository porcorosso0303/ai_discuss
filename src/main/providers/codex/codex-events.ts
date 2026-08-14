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
        usesCodexManagedCredentials: z.boolean().default(false)
      })
    ])
    .nullable()
    .optional(),
  requiresOpenaiAuth: z.boolean()
})

export const loginStartResponseSchema = z.strictObject({
  type: z.literal('chatgpt'),
  loginId: boundedId,
  authUrl: z.string().max(8_192)
})

export const loginCompletedSchema = z.strictObject({
  loginId: boundedId.nullable().optional(),
  success: z.boolean(),
  error: z.string().max(4_096).nullable().optional(),
  onboardingEntrypoint: z.literal('life_sciences').nullable().optional()
})

export const cancelLoginResponseSchema = z.strictObject({
  status: z.enum(['canceled', 'notFound'])
})

export const emptyResponseSchema = z.strictObject({})

const reasoningOptionSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema,
  description: z.string().max(4_096)
})

const modelUpgradeInfoSchema = z.strictObject({
  model: boundedId,
  migrationMarkdown: z.string().max(100_000).nullable().optional(),
  modelLink: z.string().max(8_192).nullable().optional(),
  upgradeCopy: z.string().max(10_000).nullable().optional()
})

const modelAvailabilityNuxSchema = z.strictObject({
  message: z.string().max(10_000)
})

const modelServiceTierSchema = z.strictObject({
  id: boundedId,
  name: z.string().max(200),
  description: z.string().max(4_096)
})

export const codexModelSchema = z.strictObject({
  id: boundedId,
  model: boundedId,
  upgrade: boundedId.nullable().optional(),
  upgradeInfo: modelUpgradeInfoSchema.nullable().optional(),
  availabilityNux: modelAvailabilityNuxSchema.nullable().optional(),
  displayName: z.string().trim().min(1).max(200),
  description: z.string().max(4_096),
  modelSpecialty: z.string().max(200).nullable().default(null),
  hidden: z.boolean(),
  supportedReasoningEfforts: z.array(reasoningOptionSchema).max(7),
  defaultReasoningEffort: reasoningEffortSchema,
  inputModalities: z
    .array(z.enum(['text', 'image', 'audio']))
    .max(3)
    .default(['text', 'image']),
  supportsPersonality: z.boolean().default(false),
  additionalSpeedTiers: z.array(z.string().max(200)).max(20).default([]),
  serviceTiers: z.array(modelServiceTierSchema).max(20).default([]),
  defaultServiceTier: z.string().max(200).nullable().default(null),
  isDefault: z.boolean()
})

export const modelListResponseSchema = z.strictObject({
  data: z.array(codexModelSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable().default(null)
})

const threadStatusSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notLoaded') }),
  z.strictObject({ type: z.literal('idle') }),
  z.strictObject({ type: z.literal('systemError') }),
  z.strictObject({
    type: z.literal('active'),
    activeFlags: z.array(z.enum(['waitingOnApproval', 'waitingOnUserInput'])).max(2)
  })
])

const jsonObjectSchema = z.record(z.string(), z.json())

const threadSourceSchema = z.union([
  z.enum(['cli', 'vscode', 'exec', 'appServer', 'unknown']),
  jsonObjectSchema
])

const gitInfoSchema = z.strictObject({
  sha: z.string().max(200).nullable().optional(),
  branch: z.string().max(1_000).nullable().optional(),
  originUrl: z.string().max(8_192).nullable().optional()
})

export const threadStartResponseSchema = z.strictObject({
  thread: z.strictObject({
    id: boundedId,
    sessionId: boundedId,
    forkedFromId: boundedId.nullable().optional(),
    parentThreadId: boundedId.nullable().optional(),
    preview: z.string().max(10_000),
    ephemeral: z.literal(true),
    section: z
      .strictObject({ id: boundedId, name: z.string().max(1_000) })
      .nullable()
      .default(null),
    sectionEnteredAt: z.number().int().nullable().default(null),
    modelProvider: z.string().max(200),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    recencyAt: z.number().int().nullable().optional(),
    status: threadStatusSchema,
    path: z.string().max(32_768).nullable().optional(),
    cwd: z.string().max(32_768),
    cliVersion: z.string().max(200),
    source: threadSourceSchema,
    threadSource: z.string().max(200).nullable().optional(),
    agentNickname: z.string().max(200).nullable().optional(),
    agentRole: z.string().max(200).nullable().optional(),
    gitInfo: gitInfoSchema.nullable().optional(),
    name: z.string().max(1_000).nullable().optional(),
    turns: z.array(jsonObjectSchema).max(100)
  }),
  model: boundedId,
  modelProvider: z.string().max(200),
  serviceTier: z.string().max(200).nullable().optional(),
  cwd: z.string().max(32_768),
  instructionSources: z.array(z.string().max(32_768)).max(100).default([]),
  approvalPolicy: z.literal('never'),
  approvalsReviewer: z.enum(['user', 'auto_review', 'guardian_subagent']),
  sandbox: z.strictObject({
    type: z.literal('readOnly'),
    networkAccess: z.literal(false).default(false)
  }),
  reasoningEffort: z.string().nullable().optional()
})

const turnStatusSchema = z.enum(['completed', 'interrupted', 'failed', 'inProgress'])
const turnSchema = z.strictObject({
  id: boundedId,
  items: z.array(jsonObjectSchema).max(1_000),
  itemsView: z.enum(['notLoaded', 'summary', 'full']).default('full'),
  status: turnStatusSchema,
  error: z
    .strictObject({
      message: z.string().max(4_096),
      codexErrorInfo: z.union([z.string(), jsonObjectSchema]).nullable().optional(),
      additionalDetails: z.string().max(4_096).nullable().default(null)
    })
    .nullable()
    .optional(),
  startedAt: z.number().int().nullable().optional(),
  completedAt: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional()
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
