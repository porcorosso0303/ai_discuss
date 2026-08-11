import { z } from 'zod'

import {
  DEBATE_REPLY_STATUSES,
  DEBATE_SESSION_STATES,
  DEBATE_TERMINATION_REASONS,
  PROVIDERS,
  REASONING_EFFORTS,
  ROLE_IDS,
  SAMPLING_PARAMETERS,
  STRUCTURED_OUTPUT_MODES,
  type DebateEvent,
  type DebateMessage,
  type DebateReply,
  type DebateSession,
  type DebateSetup,
  type DeepSeekRoleConfig,
  type KimiRoleConfig,
  type ModelCapabilities,
  type OpenAIRoleConfig,
  type ProviderCapabilities,
  type RoleConfig,
  type SamplingConfig,
  type Usage
} from './domain'

export const roleIdSchema = z.enum(ROLE_IDS)
export const providerSchema = z.enum(PROVIDERS)
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)

const nonEmptyTextSchema = z.string().trim().min(1)
const nonNegativeIntegerSchema = z.number().int().nonnegative()
const positiveIntegerSchema = z.number().int().positive()
const httpUrlSchema = z.string().url().refine(
  (value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  },
  { message: 'baseUrl must use HTTP or HTTPS' }
)

const commonSamplingShape = {
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional()
}

export const kimiSamplingConfigSchema = z.strictObject({
  ...commonSamplingShape,
  temperature: z.number().min(0).max(1).optional()
}) satisfies z.ZodType<SamplingConfig>

export const deepSeekSamplingConfigSchema = z.strictObject({
  ...commonSamplingShape,
  temperature: z.number().min(0).max(2).optional()
}) satisfies z.ZodType<SamplingConfig>

const commonRoleShape = {
  roleId: roleIdSchema,
  name: nonEmptyTextSchema,
  personaOrStance: z.string(),
  model: nonEmptyTextSchema
}

export const openAIRoleConfigSchema = z.strictObject({
  ...commonRoleShape,
  provider: z.literal('openai'),
  effort: reasoningEffortSchema
}) satisfies z.ZodType<OpenAIRoleConfig>

export const kimiRoleConfigSchema = z.strictObject({
  ...commonRoleShape,
  provider: z.literal('kimi'),
  baseUrl: httpUrlSchema,
  thinking: z.boolean(),
  thinkingKeep: z.boolean(),
  maxCompletionTokens: positiveIntegerSchema,
  sampling: kimiSamplingConfigSchema.optional()
}) satisfies z.ZodType<KimiRoleConfig>

export const deepSeekRoleConfigSchema = z.strictObject({
  ...commonRoleShape,
  provider: z.literal('deepseek'),
  baseUrl: httpUrlSchema,
  thinking: z.boolean(),
  effort: z.enum(['low', 'high', 'max']).optional(),
  maxTokens: positiveIntegerSchema,
  sampling: deepSeekSamplingConfigSchema.optional()
}) satisfies z.ZodType<DeepSeekRoleConfig>

export const roleConfigSchema = z.discriminatedUnion('provider', [
  openAIRoleConfigSchema,
  kimiRoleConfigSchema,
  deepSeekRoleConfigSchema
]) satisfies z.ZodType<RoleConfig>

export const debateSetupSchema = z
  .strictObject({
    topic: nonEmptyTextSchema,
    roles: z.tuple([roleConfigSchema, roleConfigSchema]),
    firstSpeaker: roleIdSchema,
    maxTurns: z.number().int().min(1).max(100).default(100)
  })
  .superRefine(({ roles, firstSpeaker }, context) => {
    const roleIds = new Set(roles.map((role) => role.roleId))
    const hasCompleteRoleSet = ROLE_IDS.every((roleId) => roleIds.has(roleId))

    if (roleIds.size !== ROLE_IDS.length || !hasCompleteRoleSet) {
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'roles must contain exactly one role-a and one role-b'
      })
    }

    if (!roleIds.has(firstSpeaker)) {
      context.addIssue({
        code: 'custom',
        path: ['firstSpeaker'],
        message: 'firstSpeaker must identify a configured role'
      })
    }
  }) satisfies z.ZodType<DebateSetup>

export const debateReplyStatusSchema = z.enum(DEBATE_REPLY_STATUSES)
export const debateReplySchema = z.strictObject({
  speech: nonEmptyTextSchema,
  status: debateReplyStatusSchema
}) satisfies z.ZodType<DebateReply>

export const usageSchema = z.strictObject({
  inputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  totalTokens: nonNegativeIntegerSchema,
  reasoningTokens: nonNegativeIntegerSchema.optional(),
  cacheReadTokens: nonNegativeIntegerSchema.optional()
}) satisfies z.ZodType<Usage>

export const debateMessageSchema = z.strictObject({
  id: nonEmptyTextSchema,
  turn: positiveIntegerSchema,
  roleId: roleIdSchema,
  provider: providerSchema,
  model: nonEmptyTextSchema,
  speech: nonEmptyTextSchema,
  status: debateReplyStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  usage: usageSchema.optional()
}) satisfies z.ZodType<DebateMessage>

export const debateSessionStateSchema = z.enum(DEBATE_SESSION_STATES)
export const debateTerminationReasonSchema = z.enum(DEBATE_TERMINATION_REASONS)

const eventBaseShape = {
  id: nonEmptyTextSchema,
  sessionId: nonEmptyTextSchema,
  createdAt: z.string().datetime({ offset: true })
}

export const debateEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('state-changed'),
    state: debateSessionStateSchema
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('turn-started'),
    roleId: roleIdSchema,
    turn: positiveIntegerSchema
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('speech-delta'),
    roleId: roleIdSchema,
    turn: positiveIntegerSchema,
    delta: z.string()
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('message-completed'),
    message: debateMessageSchema
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('context-compressed'),
    roleId: roleIdSchema,
    throughTurn: nonNegativeIntegerSchema
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('warning'),
    code: nonEmptyTextSchema,
    message: nonEmptyTextSchema,
    roleId: roleIdSchema.optional()
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('usage-updated'),
    roleId: roleIdSchema,
    usage: usageSchema
  })
]) satisfies z.ZodType<DebateEvent>

export const debateSessionSchema = z.strictObject({
  id: nonEmptyTextSchema,
  setup: debateSetupSchema,
  state: debateSessionStateSchema,
  messages: z.array(debateMessageSchema),
  events: z.array(debateEventSchema),
  currentTurn: nonNegativeIntegerSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  winnerRoleId: roleIdSchema.optional(),
  terminationReason: debateTerminationReasonSchema.optional(),
  contextCompressed: z.boolean()
}) satisfies z.ZodType<DebateSession>

export const samplingParameterSchema = z.enum(SAMPLING_PARAMETERS)
export const structuredOutputModeSchema = z.enum(STRUCTURED_OUTPUT_MODES)

export const modelCapabilitiesSchema = z
  .strictObject({
    id: nonEmptyTextSchema,
    displayName: nonEmptyTextSchema.optional(),
    reasoningEfforts: z.array(reasoningEffortSchema),
    defaultReasoningEffort: reasoningEffortSchema.optional(),
    contextLength: positiveIntegerSchema.optional(),
    thinking: z.strictObject({
      supported: z.boolean(),
      supportsKeep: z.boolean()
    }),
    sampling: z.strictObject({
      supported: z.boolean(),
      parameters: z.array(samplingParameterSchema)
    }),
    structuredOutput: z.strictObject({
      supported: z.boolean(),
      modes: z.array(structuredOutputModeSchema)
    })
  })
  .superRefine(({ reasoningEfforts, defaultReasoningEffort }, context) => {
    if (
      defaultReasoningEffort !== undefined &&
      !reasoningEfforts.includes(defaultReasoningEffort)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['defaultReasoningEffort'],
        message: 'defaultReasoningEffort must be included in reasoningEfforts'
      })
    }
  }) satisfies z.ZodType<ModelCapabilities>

export const providerCapabilitiesSchema = z.strictObject({
  provider: providerSchema,
  models: z.array(modelCapabilitiesSchema)
}) satisfies z.ZodType<ProviderCapabilities>
