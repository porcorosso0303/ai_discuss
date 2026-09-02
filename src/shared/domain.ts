export const ROLE_IDS = ['role-a', 'role-b'] as const

export const PROVIDERS = ['openai', 'kimi', 'deepseek'] as const

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const

export const DEBATE_REPLY_STATUSES = ['continue', 'concede', 'agree'] as const

export const DEBATE_SESSION_STATES = [
  'idle',
  'validating',
  'running',
  'pausing',
  'paused',
  'completed',
  'stopped',
  'unresolved',
  'refused',
  'failed'
] as const

export const DEBATE_TERMINATION_REASONS = [
  'conceded',
  'agreed',
  'max-turns',
  'user-stopped',
  'provider-refusal',
  'call-failed'
] as const

export const SAMPLING_PARAMETERS = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty'
] as const

export const STRUCTURED_OUTPUT_MODES = [
  'json-schema',
  'json-object',
  'hidden-marker'
] as const

export type {
  BaseUrl,
  ArgumentSummary,
  ArgumentSummaryMetadata,
  CredentialScope,
  DebateEvent,
  DebateMessage,
  DebateReply,
  DebateReplyStatus,
  DebateSession,
  DebateSessionState,
  DebateSetup,
  DebateTerminationReason,
  DeepSeekRoleConfig,
  DeepSeekSamplingConfig,
  KimiRoleConfig,
  KimiSamplingConfig,
  ModelCapability,
  OpenAIRoleConfig,
  Provider,
  ProviderCapabilities,
  ReasoningEffort,
  RoleConfig,
  RoleId,
  SamplingParameter,
  SamplingParameterCapability,
  StructuredOutputMode,
  Usage
} from './schemas'
