export const ROLE_IDS = ['role-a', 'role-b'] as const
export type RoleId = (typeof ROLE_IDS)[number]

export const PROVIDERS = ['openai', 'kimi', 'deepseek'] as const
export type Provider = (typeof PROVIDERS)[number]

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface SamplingConfig {
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
}

interface RoleConfigBase {
  roleId: RoleId
  name: string
  personaOrStance: string
  provider: Provider
}

export interface OpenAIRoleConfig extends RoleConfigBase {
  provider: 'openai'
  model: string
  effort: ReasoningEffort
}

export interface KimiRoleConfig extends RoleConfigBase {
  provider: 'kimi'
  baseUrl: string
  model: string
  thinkingEnabled: boolean
  thinkingKeep: boolean
  maxCompletionTokens: number
  sampling?: SamplingConfig
}

export interface DeepSeekRoleConfig extends RoleConfigBase {
  provider: 'deepseek'
  baseUrl: string
  model: string
  thinkingEnabled: boolean
  effort?: 'low' | 'high' | 'max'
  maxTokens: number
  sampling?: SamplingConfig
}

export type RoleConfig = OpenAIRoleConfig | KimiRoleConfig | DeepSeekRoleConfig

export interface DebateSetup {
  topic: string
  roles: [RoleConfig, RoleConfig]
  firstSpeaker: RoleId
  maxTurns: number
}

export const DEBATE_REPLY_STATUSES = ['continue', 'concede', 'agree'] as const
export type DebateReplyStatus = (typeof DEBATE_REPLY_STATUSES)[number]

export interface DebateReply {
  speech: string
  status: DebateReplyStatus
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
}

export interface DebateMessage extends DebateReply {
  id: string
  turn: number
  roleId: RoleId
  provider: Provider
  model: string
  createdAt: string
  usage?: Usage
}

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
export type DebateSessionState = (typeof DEBATE_SESSION_STATES)[number]

export const DEBATE_TERMINATION_REASONS = [
  'conceded',
  'agreed',
  'max-turns',
  'user-stopped',
  'provider-refusal',
  'call-failed'
] as const
export type DebateTerminationReason = (typeof DEBATE_TERMINATION_REASONS)[number]

interface DebateEventBase {
  id: string
  sessionId: string
  createdAt: string
}

export type DebateEvent =
  | (DebateEventBase & {
      type: 'state-changed'
      state: DebateSessionState
    })
  | (DebateEventBase & {
      type: 'turn-started'
      roleId: RoleId
      turn: number
    })
  | (DebateEventBase & {
      type: 'speech-delta'
      roleId: RoleId
      turn: number
      delta: string
    })
  | (DebateEventBase & {
      type: 'message-completed'
      message: DebateMessage
    })
  | (DebateEventBase & {
      type: 'context-compressed'
      roleId: RoleId
      throughTurn: number
    })
  | (DebateEventBase & {
      type: 'warning'
      code: string
      message: string
      roleId?: RoleId
    })
  | (DebateEventBase & {
      type: 'usage-updated'
      roleId: RoleId
      usage: Usage
    })

export interface DebateSession {
  id: string
  setup: DebateSetup
  state: DebateSessionState
  messages: DebateMessage[]
  events: DebateEvent[]
  currentTurn: number
  createdAt: string
  updatedAt: string
  winnerRoleId?: RoleId
  terminationReason?: DebateTerminationReason
  contextCompressed: boolean
}

export const SAMPLING_PARAMETERS = [
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty'
] as const
export type SamplingParameter = (typeof SAMPLING_PARAMETERS)[number]

export const STRUCTURED_OUTPUT_MODES = [
  'json-schema',
  'json-object',
  'hidden-marker'
] as const
export type StructuredOutputMode = (typeof STRUCTURED_OUTPUT_MODES)[number]

export interface ModelCapabilities {
  id: string
  displayName?: string
  reasoningEfforts: ReasoningEffort[]
  defaultReasoningEffort?: ReasoningEffort
  contextLength?: number
  thinking: {
    supported: boolean
    supportsKeep: boolean
  }
  sampling: {
    supported: boolean
    parameters: SamplingParameter[]
  }
  structuredOutput: {
    supported: boolean
    modes: StructuredOutputMode[]
  }
}

export interface ProviderCapabilities {
  provider: Provider
  models: ModelCapabilities[]
}
