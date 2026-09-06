import type {
  Provider as ProviderId,
  ProviderCapabilities,
  RoleConfig,
  Usage
} from '../../shared/domain'
import type { RoleView } from '../debate/prompt-builder'
import { redactString } from './http/redaction'

export interface ProviderReplyRequest {
  sessionId: string
  turn: number
  role: RoleConfig
  view: RoleView
}

export type ProviderChunk =
  | { type: 'content'; content: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'final'; finishReason?: 'stop' | 'length' | 'refusal' }

export interface Provider {
  discover(config: RoleConfig, signal?: AbortSignal): Promise<ProviderCapabilities>
  streamReply(
    request: ProviderReplyRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderChunk>
  cancelActive?(): void | Promise<void>
}

export type DebateProvider = Provider
export type ProviderRegistry = Record<ProviderId, Provider>

export class ProviderRetryableError extends Error {
  readonly retryable = true
  readonly retryAfter?: string

  constructor(message?: string, options: { retryAfter?: string } = {}) {
    super(message)
    if (options.retryAfter !== undefined) {
      this.retryAfter = redactString(options.retryAfter, { maxLength: 128 })
    }
  }
}

export class ProviderNonRetryableError extends Error {
  readonly retryable = false
}

export class ProviderRefusalError extends ProviderNonRetryableError {}

export const isRetryableProviderError = (error: unknown): boolean =>
  error instanceof ProviderRetryableError
