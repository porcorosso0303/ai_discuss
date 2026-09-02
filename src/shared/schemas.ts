import { z } from 'zod'

import {
  DEBATE_REPLY_STATUSES,
  DEBATE_SESSION_STATES,
  DEBATE_TERMINATION_REASONS,
  PROVIDERS,
  REASONING_EFFORTS,
  ROLE_IDS,
  SAMPLING_PARAMETERS,
  STRUCTURED_OUTPUT_MODES
} from './domain'

export const roleIdSchema = z.enum(ROLE_IDS)
export const providerSchema = z.enum(PROVIDERS)
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)

const boundedTextSchema = (maxLength: number) => z.string().trim().min(1).max(maxLength)
const idSchema = boundedTextSchema(200)
const modelIdSchema = boundedTextSchema(200)
const nonNegativeIntegerSchema = z.number().int().nonnegative()
const positiveIntegerSchema = z.number().int().positive()
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
const exactLoopbackHttpPattern = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i

export const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, context) => {
    try {
      const url = new URL(value)
      const hasCredentials = url.username !== '' || url.password !== ''
      const hasUnscopedSuffix = value.includes('?') || value.includes('#')
      const isSecureRemote = url.protocol === 'https:'
      const isLoopbackHttp =
        url.protocol === 'http:' &&
        loopbackHosts.has(url.hostname) &&
        exactLoopbackHttpPattern.test(value)

      if (hasCredentials || hasUnscopedSuffix || (!isSecureRemote && !isLoopbackHttp)) {
        context.addIssue({
          code: 'custom',
          message: 'baseUrl must be HTTPS, or HTTP on an exact loopback host, without credentials, query, or fragment'
        })
        return z.NEVER
      }

      return url.toString()
    } catch {
      context.addIssue({ code: 'custom', message: 'baseUrl must be a valid URL' })
      return z.NEVER
    }
  })

const credentialScopeShape = {
  roleId: roleIdSchema,
  origin: baseUrlSchema.transform((value) => new URL(value).origin)
}

export const kimiCredentialScopeSchema = z.strictObject({
  ...credentialScopeShape,
  provider: z.literal('kimi')
})

export const deepSeekCredentialScopeSchema = z.strictObject({
  ...credentialScopeShape,
  provider: z.literal('deepseek')
})

export const credentialScopeSchema = z.discriminatedUnion('provider', [
  kimiCredentialScopeSchema,
  deepSeekCredentialScopeSchema
])

const commonSamplingShape = {
  temperature: z.number().min(0).optional(),
  topP: z.number().min(0).max(1).optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional()
}

export const kimiSamplingConfigSchema = z.strictObject({
  ...commonSamplingShape,
  temperature: z.number().min(0).max(1).optional()
})

export const deepSeekSamplingConfigSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional()
})

const commonRoleShape = {
  roleId: roleIdSchema,
  name: boundedTextSchema(100),
  personaOrStance: z.string().max(4000),
  model: modelIdSchema
}

export const openAIRoleConfigSchema = z.strictObject({
  ...commonRoleShape,
  provider: z.literal('openai'),
  effort: reasoningEffortSchema
})

export const kimiRoleConfigSchema = z
  .strictObject({
    ...commonRoleShape,
    provider: z.literal('kimi'),
    baseUrl: baseUrlSchema,
    thinking: z.boolean().optional(),
    thinkingKeep: z.enum(['none', 'all']).optional(),
    effort: z.enum(['low', 'high', 'max']).optional(),
    maxCompletionTokens: positiveIntegerSchema,
    sampling: kimiSamplingConfigSchema.optional()
  })
  .superRefine(({ model, thinking, thinkingKeep, effort, maxCompletionTokens, sampling }, context) => {
    const isK3 = /^kimi-k3(?:$|-)/.test(model)
    const isK27Code = /^kimi-k2\.7-code(?:$|-)/.test(model)
    const isK26 = /^kimi-k2\.6(?:$|-)/.test(model)
    const isK25 = /^kimi-k2\.5(?:$|-)/.test(model)

    if (!isK3 && effort !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message: 'reasoning effort is supported only by Kimi K3'
      })
    }

    if (isK3) {
      if (maxCompletionTokens > 1_048_576) {
        context.addIssue({
          code: 'custom',
          path: ['maxCompletionTokens'],
          message: 'Kimi K3 maxCompletionTokens must not exceed 1048576'
        })
      }
      if (thinking !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['thinking'],
          message: 'Kimi K3 always reasons and does not accept thinking'
        })
      }
      if (thinkingKeep !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['thinkingKeep'],
          message: 'Kimi K3 preserved thinking is fixed and not configurable'
        })
      }
      if (sampling !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['sampling'],
          message: 'Kimi K3 sampling values are fixed and must be omitted'
        })
      }
      return
    }

    if (isK27Code) {
      if (thinking === false) {
        context.addIssue({
          code: 'custom',
          path: ['thinking'],
          message: 'Kimi K2.7 Code thinking cannot be disabled'
        })
      }
      if (thinkingKeep === 'none') {
        context.addIssue({
          code: 'custom',
          path: ['thinkingKeep'],
          message: 'Kimi K2.7 Code preserved thinking is always enabled'
        })
      }
      if (sampling !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['sampling'],
          message: 'Kimi K2.7 Code sampling values are fixed and must be omitted'
        })
      }
      return
    }

    if ((isK26 || isK25) && sampling !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sampling'],
        message: 'sampling values are fixed for this Kimi model and must be omitted'
      })
    }

    if (isK25 && thinkingKeep !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['thinkingKeep'],
        message: 'Kimi K2.5 does not support preserved thinking'
      })
    }

    if (!isK26 && !isK25 && thinking === true && sampling !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sampling'],
        message: 'sampling parameters are unavailable while Kimi thinking is enabled'
      })
    }

    if (thinking === false && thinkingKeep === 'all') {
      context.addIssue({
        code: 'custom',
        path: ['thinkingKeep'],
        message: 'thinkingKeep all requires thinking to be enabled'
      })
    }
  })

export const deepSeekRoleConfigSchema = z
  .strictObject({
    ...commonRoleShape,
    provider: z.literal('deepseek'),
    baseUrl: baseUrlSchema,
    thinking: z.boolean().optional(),
    effort: z.enum(['low', 'high', 'max']).optional(),
    maxTokens: positiveIntegerSchema,
    sampling: deepSeekSamplingConfigSchema.optional()
  })
  .superRefine(({ model, thinking, effort, maxTokens, sampling }, context) => {
    if (/^deepseek-v4-(?:flash|pro)$/.test(model) && maxTokens > 384_000) {
      context.addIssue({
        code: 'custom',
        path: ['maxTokens'],
        message: 'DeepSeek V4 maxTokens must not exceed 384000'
      })
    }

    if (thinking !== false && sampling !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sampling'],
        message: 'sampling parameters require explicitly disabled thinking'
      })
    }

    if (thinking === false && effort !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message: 'effort is unavailable while thinking is disabled'
      })
    }
  })

export const roleConfigSchema = z.discriminatedUnion('provider', [
  openAIRoleConfigSchema,
  kimiRoleConfigSchema,
  deepSeekRoleConfigSchema
])

export const debateSetupSchema = z
  .strictObject({
    topic: boundedTextSchema(10_000),
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
  })

export const debateReplyStatusSchema = z.enum(DEBATE_REPLY_STATUSES)
export const debateReplySchema = z.strictObject({
  speech: boundedTextSchema(200_000),
  status: debateReplyStatusSchema
})

export const usageSchema = z.strictObject({
  inputTokens: nonNegativeIntegerSchema,
  outputTokens: nonNegativeIntegerSchema,
  totalTokens: nonNegativeIntegerSchema,
  reasoningTokens: nonNegativeIntegerSchema.optional(),
  cacheReadTokens: nonNegativeIntegerSchema.optional()
})

export const ARGUMENT_SUMMARY_ITEM_MAX_LENGTH = 4000
export const ARGUMENT_SUMMARY_CONTENT_MAX_LENGTH = 32_000

const argumentSummaryItemSchema = z
  .string()
  .trim()
  .min(1)
  .max(ARGUMENT_SUMMARY_ITEM_MAX_LENGTH)

export const argumentSummarySchema = z
  .strictObject({
    claims: z.array(argumentSummaryItemSchema).max(100),
    evidence: z.array(argumentSummaryItemSchema).max(100),
    concessions: z.array(argumentSummaryItemSchema).max(100),
    disputes: z.array(argumentSummaryItemSchema).max(100)
  })
  .refine(
    ({ claims, evidence, concessions, disputes }) =>
      claims.length + evidence.length + concessions.length + disputes.length > 0,
    { message: 'argument summary must not be empty' }
  )
  .refine(
    ({ claims, evidence, concessions, disputes }) =>
      [...claims, ...evidence, ...concessions, ...disputes].reduce(
        (total, item) => total + item.length,
        0
      ) <= ARGUMENT_SUMMARY_CONTENT_MAX_LENGTH,
    { message: 'argument summary exceeds the aggregate content limit' }
  )

export const argumentSummaryMetadataSchema = z
  .strictObject({
    id: z.string().trim().min(1).max(200),
    createdAt: z.string().datetime({ offset: true }),
    coveredFromTurn: z.number().int().positive(),
    coveredThroughTurn: z.number().int().positive(),
    provider: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    source: z.enum(['provider', 'fallback']),
    summary: argumentSummarySchema,
    warning: z.string().trim().min(1).max(4000).optional()
  })
  .refine(({ coveredFromTurn, coveredThroughTurn }) => coveredFromTurn <= coveredThroughTurn, {
    message: 'coveredFromTurn must not exceed coveredThroughTurn'
  })

export const debateMessageSchema = z.strictObject({
  id: idSchema,
  turn: positiveIntegerSchema,
  roleId: roleIdSchema,
  provider: providerSchema,
  model: modelIdSchema,
  speech: boundedTextSchema(200_000),
  status: debateReplyStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  usage: usageSchema.optional()
})

export const debateSessionStateSchema = z.enum(DEBATE_SESSION_STATES)
export const debateTerminationReasonSchema = z.enum(DEBATE_TERMINATION_REASONS)

const eventBaseShape = {
  id: idSchema,
  sessionId: idSchema,
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
    delta: z.string().max(200_000)
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('speech-reset'),
    roleId: roleIdSchema,
    turn: positiveIntegerSchema
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
    throughTurn: nonNegativeIntegerSchema,
    summary: argumentSummaryMetadataSchema.optional()
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('warning'),
    code: boundedTextSchema(100),
    message: boundedTextSchema(4000),
    roleId: roleIdSchema.optional(),
    turn: positiveIntegerSchema.optional(),
    attempt: positiveIntegerSchema.optional(),
    retryable: z.boolean().optional()
  }),
  z.strictObject({
    ...eventBaseShape,
    type: z.literal('usage-updated'),
    roleId: roleIdSchema,
    usage: usageSchema
  })
])

export const debateSessionSchema = z.strictObject({
  id: idSchema,
  setup: debateSetupSchema,
  state: debateSessionStateSchema,
  messages: z.array(debateMessageSchema).max(100),
  events: z.array(debateEventSchema).max(10_000),
  currentTurn: nonNegativeIntegerSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  winnerRoleId: roleIdSchema.optional(),
  terminationReason: debateTerminationReasonSchema.optional(),
  contextCompressed: z.boolean()
})

export const samplingParameterSchema = z.enum(SAMPLING_PARAMETERS)
export const structuredOutputModeSchema = z.enum(STRUCTURED_OUTPUT_MODES)

const uniqueValues = <Value>(values: Value[]): boolean => new Set(values).size === values.length

export const samplingParameterCapabilitySchema = z
  .strictObject({
    name: samplingParameterSchema,
    min: z.number(),
    max: z.number(),
    default: z.number().optional()
  })
  .superRefine(({ min, max, default: defaultValue }, context) => {
    if (min > max) {
      context.addIssue({ code: 'custom', path: ['min'], message: 'min must not exceed max' })
    }

    if (defaultValue !== undefined && (defaultValue < min || defaultValue > max)) {
      context.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'default must be within the declared range'
      })
    }
  })

export const modelCapabilitySchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(200).optional(),
  reasoningEfforts: z
    .array(reasoningEffortSchema)
    .max(REASONING_EFFORTS.length)
    .refine(uniqueValues, { message: 'reasoningEfforts must be unique' }),
  defaultReasoningEffort: reasoningEffortSchema.optional(),
  inputModalities: z
    .array(z.enum(['text', 'image', 'audio']))
    .max(3)
    .refine(uniqueValues, { message: 'inputModalities must be unique' })
    .optional(),
  contextLength: positiveIntegerSchema.max(10_000_000).optional(),
  maxOutputTokens: positiveIntegerSchema.max(10_000_000).optional(),
  thinking: z
    .strictObject({
      default: z.boolean(),
      keepSupported: z.boolean()
    })
    .nullable(),
  samplingParameters: z
    .array(samplingParameterCapabilitySchema)
    .max(SAMPLING_PARAMETERS.length)
    .refine((parameters) => uniqueValues(parameters.map(({ name }) => name)), {
      message: 'sampling parameter names must be unique'
    }),
  structuredOutputModes: z
    .array(structuredOutputModeSchema)
    .max(STRUCTURED_OUTPUT_MODES.length)
    .refine(uniqueValues, { message: 'structured output modes must be unique' })
}).superRefine(({ reasoningEfforts, defaultReasoningEffort }, context) => {
  if (
    defaultReasoningEffort !== undefined &&
    !reasoningEfforts.includes(defaultReasoningEffort)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['defaultReasoningEffort'],
      message: 'defaultReasoningEffort must be supported by the model'
    })
  }
})

export const providerCapabilitiesSchema = z
  .strictObject({
    provider: providerSchema,
    models: z
      .array(modelCapabilitySchema)
      .max(200)
      .refine((models) => uniqueValues(models.map(({ id }) => id)), {
        message: 'model ids must be unique'
      }),
    defaultModel: z.string().trim().min(1).max(200).optional()
  })
  .superRefine(({ models, defaultModel }, context) => {
    if (defaultModel !== undefined && !models.some(({ id }) => id === defaultModel)) {
      context.addIssue({
        code: 'custom',
        path: ['defaultModel'],
        message: 'defaultModel must identify a discovered model'
      })
    }
  })

export type RoleId = z.output<typeof roleIdSchema>
export type Provider = z.output<typeof providerSchema>
export type ReasoningEffort = z.output<typeof reasoningEffortSchema>
export type BaseUrl = z.output<typeof baseUrlSchema>
export type CredentialScope = z.output<typeof credentialScopeSchema>
export type KimiSamplingConfig = z.output<typeof kimiSamplingConfigSchema>
export type DeepSeekSamplingConfig = z.output<typeof deepSeekSamplingConfigSchema>
export type OpenAIRoleConfig = z.output<typeof openAIRoleConfigSchema>
export type KimiRoleConfig = z.output<typeof kimiRoleConfigSchema>
export type DeepSeekRoleConfig = z.output<typeof deepSeekRoleConfigSchema>
export type RoleConfig = z.output<typeof roleConfigSchema>
export type DebateSetup = z.output<typeof debateSetupSchema>
export type DebateReplyStatus = z.output<typeof debateReplyStatusSchema>
export type DebateReply = z.output<typeof debateReplySchema>
export type Usage = z.output<typeof usageSchema>
export type ArgumentSummary = z.output<typeof argumentSummarySchema>
export type ArgumentSummaryMetadata = z.output<typeof argumentSummaryMetadataSchema>
export type DebateMessage = z.output<typeof debateMessageSchema>
export type DebateSessionState = z.output<typeof debateSessionStateSchema>
export type DebateTerminationReason = z.output<typeof debateTerminationReasonSchema>
export type DebateEvent = z.output<typeof debateEventSchema>
export type DebateSession = z.output<typeof debateSessionSchema>
export type SamplingParameter = z.output<typeof samplingParameterSchema>
export type StructuredOutputMode = z.output<typeof structuredOutputModeSchema>
export type SamplingParameterCapability = z.output<typeof samplingParameterCapabilitySchema>
export type ModelCapability = z.output<typeof modelCapabilitySchema>
export type ProviderCapabilities = z.output<typeof providerCapabilitiesSchema>
