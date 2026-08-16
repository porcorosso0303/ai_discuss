import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ModelCapability,
  OpenAIRoleConfig,
  ProviderCapabilities,
  ReasoningEffort,
  RoleConfig,
  RoleId,
  Usage
} from '../../../shared/domain'
import { openAIRoleConfigSchema, providerCapabilitiesSchema } from '../../../shared/schemas'
import {
  ProviderNonRetryableError,
  ProviderRetryableError,
  type Provider,
  type ProviderChunk,
  type ProviderReplyRequest
} from '../provider'
import {
  DEBATE_OUTPUT_SCHEMA,
  accountReadResponseSchema,
  agentMessageDeltaSchema,
  cancelLoginResponseSchema,
  emptyResponseSchema,
  itemCompletedSchema,
  itemStartedSchema,
  loginCompletedSchema,
  loginStartResponseSchema,
  modelListResponseSchema,
  threadStartResponseSchema,
  threadTokenUsageUpdatedSchema,
  turnCompletedSchema,
  turnStartResponseSchema,
  type AgentMessageDelta,
  type CodexModel,
  type CodexErrorInfo,
  type ItemCompleted,
  type ItemStarted,
  type LoginCompleted,
  type ThreadTokenUsageUpdated,
  type TurnCompleted
} from './codex-events'
import {
  CodexJsonRpcClient,
  JsonRpcProtocolError,
  JsonRpcServerError,
  JsonRpcTransportError
} from './jsonrpc-client'

const MAX_MODELS = 200
const MAX_MODEL_PAGES = 10
const MODEL_PAGE_SIZE = 100
const MAX_VISIBLE_CONTENT_CHARS = 201_000
const MAX_INPUT_CHARS = 800_000
const MAX_TURN_EVENTS = 4_096
const MAX_TURN_EVENT_BYTES = 1024 * 1024
const DEFAULT_TURN_TIMEOUT_MS = 180_000

interface RoleThread {
  threadId: string
  cwd: string
}

interface ActiveTurn {
  client: CodexJsonRpcClient
  threadId: string
  turnId: string
  interruptSent: boolean
  fail: (error: Error) => void
}

interface ProviderConnection {
  client: CodexJsonRpcClient
  removeLoginListener: () => void
  removeFailureListener: () => void
}

interface TurnState {
  cancelled: boolean
  cancellationError?: Error
  active?: ActiveTurn
}

interface LoginWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

export interface CodexAccountStatus {
  signedIn: boolean
  requiresOpenaiAuth: boolean
  planType?: string
}

export interface CodexLoginAttempt {
  loginId: string
  completion: Promise<void>
}

export interface CodexProviderDependencies {
  createClient: () => Promise<CodexJsonRpcClient>
  openExternal: (url: string) => Promise<unknown>
  createEmptyCwd?: (roleId: RoleId) => Promise<string>
  removeEmptyCwd?: (path: string) => Promise<void>
  turnTimeoutMs?: number
}

class AsyncEventQueue<Event> {
  private values: Event[] = []
  private valueBytes = 0
  private waiter:
    | { resolve: (value: IteratorResult<Event>) => void; reject: (error: Error) => void }
    | undefined
  private closed = false
  private failure: Error | undefined

  constructor(
    private readonly maxValues: number,
    private readonly maxBytes: number,
    private readonly sizeOf: (value: Event) => number,
    private readonly overflowError: () => Error
  ) {}

  push(value: Event): void {
    if (this.closed || this.failure !== undefined) return
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve({ value, done: false })
    } else {
      const valueBytes = this.sizeOf(value)
      if (
        !Number.isSafeInteger(valueBytes) ||
        valueBytes < 0 ||
        this.values.length >= this.maxValues ||
        this.valueBytes + valueBytes > this.maxBytes
      ) {
        this.fail(this.overflowError())
        return
      }
      this.values.push(value)
      this.valueBytes += valueBytes
    }
  }

  close(): void {
    if (this.closed || this.failure !== undefined) return
    this.closed = true
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure !== undefined) return
    this.failure = error
    this.values = []
    this.valueBytes = 0
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.reject(error)
    }
  }

  next(): Promise<IteratorResult<Event>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const value = this.values.shift()
    if (value !== undefined) {
      this.valueBytes -= this.sizeOf(value)
      return Promise.resolve({ value, done: false })
    }
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
}

type TurnEvent =
  | { type: 'delta'; value: AgentMessageDelta }
  | {
      type: 'item'
      lifecycle: 'started' | 'completed'
      value: ItemStarted | ItemCompleted
    }
  | { type: 'usage'; value: ThreadTokenUsageUpdated }
  | { type: 'completed'; value: TurnCompleted }

type VisibleTurnEvent =
  | { type: 'delta'; value: AgentMessageDelta }
  | { type: 'usage'; value: Usage }
  | { type: 'completed'; value: TurnCompleted }

const turnEventBytes = (event: TurnEvent): number =>
  event.type === 'delta'
    ? Buffer.byteLength(event.value.delta, 'utf8') + 128
    : Buffer.byteLength(JSON.stringify(event.value), 'utf8') + 128

const visibleEventBytes = (event: VisibleTurnEvent): number =>
  event.type === 'delta'
    ? Buffer.byteLength(event.value.delta, 'utf8') + 128
    : Buffer.byteLength(JSON.stringify(event.value), 'utf8') + 128

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const safeAbortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('Stopped', 'AbortError')

const normalizeError = (error: unknown, signal?: AbortSignal): Error => {
  if (signal?.aborted === true) return safeAbortError(signal)
  if (
    error instanceof ProviderNonRetryableError ||
    error instanceof ProviderRetryableError
  ) {
    return error
  }
  if (error instanceof JsonRpcTransportError) {
    return new ProviderRetryableError('Codex App Server became unavailable')
  }
  if (error instanceof JsonRpcServerError && error.code === -32001) {
    return new ProviderRetryableError('Codex App Server is temporarily overloaded')
  }
  if (error instanceof JsonRpcProtocolError || error instanceof JsonRpcServerError) {
    return new ProviderNonRetryableError('Codex App Server rejected an invalid operation')
  }
  return new ProviderNonRetryableError('Codex App Server response was invalid')
}

const transientHttpStatus = (status: number | null): boolean =>
  status === 429 || (status !== null && status >= 500 && status <= 599)

const isRetryableCodexError = (info: CodexErrorInfo | null | undefined): boolean => {
  if (info === 'serverOverloaded' || info === 'internalServerError') return true
  if (typeof info !== 'object' || info === null) return false
  if ('responseStreamConnectionFailed' in info) return true
  if ('responseStreamDisconnected' in info) return true
  if ('responseTooManyFailedAttempts' in info) return true
  if ('httpConnectionFailed' in info) {
    return transientHttpStatus(info.httpConnectionFailed.httpStatusCode)
  }
  return false
}

const turnFailureError = (turn: TurnCompleted['turn']): Error =>
  isRetryableCodexError(turn.error?.codexErrorInfo)
    ? new ProviderRetryableError('Codex turn failed temporarily')
    : new ProviderNonRetryableError('Codex turn did not complete successfully')

const HOSTILE_ITEM_TYPES = new Set([
  'hookPrompt',
  'plan',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction'
])

const SAFE_COMPLETION_ITEM_TYPES = new Set(['agentMessage', 'userMessage', 'reasoning'])

const containsHostileItem = (items: ReadonlyArray<Record<string, unknown>>): boolean =>
  items.some(
    (item) =>
      typeof item.type !== 'string' || !SAFE_COMPLETION_ITEM_TYPES.has(item.type)
  )

const isAllowedLoginUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    const allowedHost =
      host === 'openai.com' ||
      host.endsWith('.openai.com') ||
      host === 'chatgpt.com' ||
      host.endsWith('.chatgpt.com')
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      allowedHost
    )
  } catch {
    return false
  }
}

const mapModel = (model: CodexModel): ModelCapability => ({
  id: model.id,
  displayName: model.displayName,
  reasoningEfforts: model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort),
  defaultReasoningEffort: model.defaultReasoningEffort,
  inputModalities: model.inputModalities,
  thinking: null,
  samplingParameters: [],
  structuredOutputModes: ['json-schema']
})

const renderInput = (request: ProviderReplyRequest): string => {
  const transcript = request.view.messages
    .map(({ role, content }) => `[${role === 'assistant' ? '本角色历史发言' : '对手发言'}]\n${content}`)
    .join('\n\n')
  const result = `${request.view.system}\n\n[当前可见对话]\n${transcript || '（无历史发言）'}\n\n请现在严格按上述 JSON contract 回应。`
  if (result.length > MAX_INPUT_CHARS) {
    throw new ProviderNonRetryableError('Codex debate context exceeds the safe input limit')
  }
  return result
}

const validateCatalog = (catalog: CodexModel[]): void => {
  if (catalog.length === 0 || catalog.length > MAX_MODELS) {
    throw new ProviderNonRetryableError('Codex returned an invalid model catalog')
  }
  const ids = new Set<string>()
  let defaults = 0
  for (const model of catalog) {
    if (ids.has(model.id)) throw new ProviderNonRetryableError('Codex returned duplicate models')
    ids.add(model.id)
    if (model.isDefault) defaults += 1
    const efforts = model.supportedReasoningEfforts.map(({ reasoningEffort }) => reasoningEffort)
    if (new Set(efforts).size !== efforts.length || !efforts.includes(model.defaultReasoningEffort)) {
      throw new ProviderNonRetryableError('Codex returned invalid reasoning capabilities')
    }
  }
  if (defaults > 1) throw new ProviderNonRetryableError('Codex returned multiple default models')
}

export class CodexProvider implements Provider {
  private readonly createEmptyCwd: (roleId: RoleId) => Promise<string>
  private readonly removeEmptyCwd: (path: string) => Promise<void>
  private readonly turnTimeoutMs: number
  private readonly capabilitiesByRole = new Map<RoleId, ReadonlyMap<string, ModelCapability>>()
  private readonly activeTurns = new Map<RoleId, ActiveTurn>()
  private readonly turnStates = new Map<RoleId, TurnState>()
  private readonly loginWaiters = new Map<string, LoginWaiter>()
  private readonly completedLogins = new Map<string, LoginCompleted>()
  private readonly ignoredLoginIds = new Set<string>()
  private connection: ProviderConnection | undefined
  private connectionPromise: Promise<CodexJsonRpcClient> | undefined
  private readonly failedClients = new WeakMap<CodexJsonRpcClient, Error>()
  private disposed = false
  private loginAttemptActive = false
  private activeLoginId: string | undefined

  constructor(private readonly dependencies: CodexProviderDependencies) {
    this.createEmptyCwd =
      dependencies.createEmptyCwd ??
      ((roleId) => mkdtemp(join(tmpdir(), `ai-debates-codex-${roleId}-`)))
    this.removeEmptyCwd =
      dependencies.removeEmptyCwd ??
      ((path) => rm(path, { recursive: true, force: true }))
    this.turnTimeoutMs = dependencies.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    if (!Number.isSafeInteger(this.turnTimeoutMs) || this.turnTimeoutMs <= 0) {
      throw new RangeError('turnTimeoutMs must be a positive safe integer')
    }
  }

  async readAccount(): Promise<CodexAccountStatus> {
    this.ensureUsable()
    try {
      const client = await this.getClient()
      const response = await client.request(
        'account/read',
        { refreshToken: false },
        accountReadResponseSchema
      )
      this.throwIfClientFailed(client)
      if (response.account?.type !== 'chatgpt') {
        return { signedIn: false, requiresOpenaiAuth: response.requiresOpenaiAuth }
      }
      return {
        signedIn: true,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
        planType: response.account.planType
      }
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async startChatGptLogin(): Promise<CodexLoginAttempt> {
    this.ensureUsable()
    if (this.loginAttemptActive) {
      throw new ProviderNonRetryableError('A ChatGPT login attempt is already active')
    }
    this.loginAttemptActive = true
    this.completedLogins.clear()
    try {
      const client = await this.getClient()
      const response = await client.request(
        'account/login/start',
        { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' },
        loginStartResponseSchema
      )
      this.throwIfClientFailed(client)
      this.activeLoginId = response.loginId
      if (!isAllowedLoginUrl(response.authUrl)) {
        this.ignoreLoginCompletion(response.loginId)
        void client
          .request(
            'account/login/cancel',
            { loginId: response.loginId },
            cancelLoginResponseSchema
          )
          .catch(() => undefined)
        throw new ProviderNonRetryableError('Codex returned an unsafe login destination')
      }
      let resolveCompletion!: () => void
      let rejectCompletion!: (error: Error) => void
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      })
      // A UI may intentionally fire-and-forget the attempt while it is closing.
      // Keep the returned promise rejectable without creating an unhandled rejection.
      void completion.catch(() => undefined)
      this.loginWaiters.set(response.loginId, {
        resolve: resolveCompletion,
        reject: rejectCompletion
      })
      const completed = this.completedLogins.get(response.loginId)
      this.completedLogins.clear()
      if (completed !== undefined) this.settleLogin(response.loginId, completed)
      try {
        await this.dependencies.openExternal(response.authUrl)
      } catch {
        const waiter = this.loginWaiters.get(response.loginId)
        this.loginWaiters.delete(response.loginId)
        this.ignoreLoginCompletion(response.loginId)
        waiter?.reject(new ProviderNonRetryableError('Unable to open the secure ChatGPT login page'))
        void client
          .request(
            'account/login/cancel',
            { loginId: response.loginId },
            cancelLoginResponseSchema
          )
          .catch(() => undefined)
        throw new ProviderNonRetryableError('Unable to open the secure ChatGPT login page')
      }
      return { loginId: response.loginId, completion }
    } catch (error) {
      this.loginAttemptActive = false
      this.activeLoginId = undefined
      this.completedLogins.clear()
      throw normalizeError(error)
    }
  }

  async cancelChatGptLogin(loginId: string): Promise<void> {
    this.ensureUsable()
    try {
      const client = await this.getClient()
      const response = await client.request(
        'account/login/cancel',
        { loginId },
        cancelLoginResponseSchema
      )
      this.throwIfClientFailed(client)
      if (response.status !== 'canceled') {
        this.completedLogins.delete(loginId)
        return
      }
      const waiter = this.loginWaiters.get(loginId)
      if (this.activeLoginId !== loginId || waiter === undefined) {
        this.completedLogins.delete(loginId)
        return
      }
      this.loginWaiters.delete(loginId)
      this.loginAttemptActive = false
      this.activeLoginId = undefined
      this.completedLogins.delete(loginId)
      this.ignoreLoginCompletion(loginId)
      waiter.reject(new ProviderNonRetryableError('ChatGPT login was canceled'))
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async logout(): Promise<void> {
    this.ensureUsable()
    try {
      const client = await this.getClient()
      await client.request('account/logout', undefined, emptyResponseSchema)
      this.throwIfClientFailed(client)
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async discover(config: RoleConfig, signal?: AbortSignal): Promise<ProviderCapabilities> {
    this.ensureUsable()
    let openaiConfig: OpenAIRoleConfig
    try {
      openaiConfig = openAIRoleConfigSchema.parse(config)
    } catch (error) {
      throw normalizeError(error, signal)
    }
    const models: CodexModel[] = []
    const cursors = new Set<string>()
    let cursor: string | null = null
    try {
      const client = await this.getClient()
      const account = await this.readAccount()
      if (!account.signedIn) {
        throw new ProviderNonRetryableError('ChatGPT sign-in is required for OpenAI debates')
      }
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const params: { limit: number; includeHidden: false; cursor?: string } = {
          limit: MODEL_PAGE_SIZE,
          includeHidden: false
        }
        if (cursor !== null) params.cursor = cursor
        const response = await client.request(
          'model/list',
          params,
          modelListResponseSchema
        )
        this.throwIfClientFailed(client)
        models.push(...response.data)
        if (models.length > MAX_MODELS) {
          throw new ProviderNonRetryableError('Codex returned too many models')
        }
        if (response.nextCursor === null) break
        if (cursors.has(response.nextCursor)) {
          throw new ProviderNonRetryableError('Codex returned an invalid model cursor')
        }
        cursors.add(response.nextCursor)
        cursor = response.nextCursor
        if (page === MAX_MODEL_PAGES - 1) {
          throw new ProviderNonRetryableError('Codex model pagination exceeded the safe limit')
        }
      }
      validateCatalog(models)
      const visible = models.filter(({ inputModalities }) => inputModalities.includes('text'))
      const selected = visible.find(({ id }) => id === openaiConfig.model)
      if (selected === undefined) {
        throw new ProviderNonRetryableError('The selected Codex model is unavailable')
      }
      if (
        !selected.supportedReasoningEfforts.some(
          ({ reasoningEffort }) => reasoningEffort === openaiConfig.effort
        )
      ) {
        throw new ProviderNonRetryableError(
          'The selected Codex model does not support the configured reasoning effort'
        )
      }
      const mapped = visible.map(mapModel)
      this.capabilitiesByRole.set(
        openaiConfig.roleId,
        new Map(mapped.map((capability) => [capability.id, capability]))
      )
      const defaultModel = visible.find(({ isDefault }) => isDefault)?.id ?? visible[0]?.id
      return providerCapabilitiesSchema.parse({
        provider: 'openai',
        models: mapped,
        ...(defaultModel === undefined ? {} : { defaultModel })
      })
    } catch (error) {
      throw normalizeError(error, signal)
    }
  }

  async *streamReply(
    request: ProviderReplyRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderChunk> {
    this.ensureUsable()
    let config: OpenAIRoleConfig
    let state: TurnState
    try {
      config = openAIRoleConfigSchema.parse(request.role)
      const capability = this.capabilitiesByRole.get(config.roleId)?.get(config.model)
      if (capability === undefined || !capability.reasoningEfforts.includes(config.effort)) {
        throw new ProviderNonRetryableError('Codex model capabilities must be validated first')
      }
      if (signal.aborted) throw safeAbortError(signal)
      if (this.turnStates.has(config.roleId)) {
        throw new ProviderNonRetryableError('This Codex role already has an active turn')
      }
      state = { cancelled: false }
      this.turnStates.set(config.roleId, state)
    } catch (error) {
      throw normalizeError(error, signal)
    }

    let client: CodexJsonRpcClient
    let thread: RoleThread
    try {
      client = await this.getClient()
      this.throwIfStopped(signal, state)
      thread = await this.prepareThread(client, config, request, signal, state)
    } catch (error) {
      if (this.turnStates.get(config.roleId) === state) this.turnStates.delete(config.roleId)
      throw normalizeError(error, signal)
    }
    const eventLimitError = (): ProviderNonRetryableError =>
      new ProviderNonRetryableError('Codex turn event stream exceeds the safe limit')
    const queue = new AsyncEventQueue<VisibleTurnEvent>(
      MAX_TURN_EVENTS,
      MAX_TURN_EVENT_BYTES,
      visibleEventBytes,
      eventLimitError
    )
    const buffered: TurnEvent[] = []
    const bufferedMalformed: Array<{ turnId: string; error: Error }> = []
    let bufferedBytes = 0
    let observedEvents = 0
    let observedBytes = 0
    let acceptingEvents = true
    let turnId: string | undefined
    const deltaItemIds = new Set<string>()
    const completedAgentMessages = new Map<
      string,
      { phase: 'commentary' | 'final_answer' | null; text: string }
    >()
    let latestUsage: Usage | undefined
    let completed = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const failTurn = (error: Error): void => {
      acceptingEvents = false
      buffered.length = 0
      bufferedMalformed.length = 0
      bufferedBytes = 0
      deltaItemIds.clear()
      completedAgentMessages.clear()
      queue.fail(error)
    }

    const dispatch = (event: TurnEvent): void => {
      if (turnId === undefined) {
        return
      }
      const eventThreadId = event.value.threadId
      const eventTurnId =
        event.type === 'completed' ? event.value.turn.id : event.value.turnId
      if (eventThreadId !== thread.threadId || eventTurnId !== turnId) return
      if (completed || !acceptingEvents) return
      if (event.type === 'delta') {
        deltaItemIds.add(event.value.itemId)
        return
      }
      if (event.type === 'item') {
        if (event.value.item.type === 'agentMessage') {
          if (event.lifecycle === 'completed') {
            completedAgentMessages.set(event.value.item.id, {
              phase: event.value.item.phase,
              text: event.value.item.text
            })
          }
        } else if (HOSTILE_ITEM_TYPES.has(event.value.item.type)) {
          failTurn(new ProviderNonRetryableError('Codex attempted a forbidden debate action'))
        }
        return
      }
      if (event.type === 'usage') {
        const usage = event.value.tokenUsage.last
        latestUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          reasoningTokens: usage.reasoningOutputTokens,
          cacheReadTokens: usage.cachedInputTokens
        }
        return
      }
      completed = true
      if (containsHostileItem(event.value.turn.items)) {
        failTurn(new ProviderNonRetryableError('Codex attempted a forbidden debate action'))
      } else if (event.value.turn.status !== 'completed') {
        failTurn(turnFailureError(event.value.turn))
      } else if (
        [...deltaItemIds].some((itemId) => !completedAgentMessages.has(itemId))
      ) {
        failTurn(new ProviderNonRetryableError('Codex emitted text without an item lifecycle'))
      } else if (latestUsage === undefined) {
        failTurn(new ProviderNonRetryableError('Codex completed without valid usage data'))
      } else {
        const messages = [...completedAgentMessages.entries()]
        const explicitFinal = messages.filter(([, message]) => message.phase === 'final_answer')
        const candidates =
          explicitFinal.length > 0
            ? explicitFinal
            : messages.filter(([, message]) => message.phase === null)
        const candidate = candidates[0]
        if (
          candidates.length !== 1 ||
          candidate === undefined ||
          candidate[1].text.length === 0
        ) {
          failTurn(new ProviderNonRetryableError('Codex completed without a visible response'))
        } else if (candidate[1].text.length > MAX_VISIBLE_CONTENT_CHARS) {
          failTurn(new ProviderNonRetryableError('Codex visible response exceeds the safe limit'))
        } else {
          queue.push({
            type: 'delta',
            value: {
              threadId: thread.threadId,
              turnId,
              itemId: candidate[0],
              delta: candidate[1].text
            }
          })
          queue.push({ type: 'usage', value: latestUsage })
          queue.push(event)
          queue.close()
        }
      }
    }

    const reserveEvent = (eventBytes: number): boolean => {
      if (!acceptingEvents || completed) return false
      observedEvents += 1
      observedBytes += eventBytes
      if (observedEvents > MAX_TURN_EVENTS || observedBytes > MAX_TURN_EVENT_BYTES) {
        failTurn(eventLimitError())
        return false
      }
      return true
    }

    const receive = (event: TurnEvent): void => {
      const eventBytes = turnEventBytes(event)
      if (!reserveEvent(eventBytes)) return
      if (turnId === undefined) {
        if (
          buffered.length >= MAX_TURN_EVENTS ||
          bufferedBytes + eventBytes > MAX_TURN_EVENT_BYTES
        ) {
          failTurn(eventLimitError())
          return
        }
        buffered.push(event)
        bufferedBytes += eventBytes
        return
      }
      dispatch(event)
    }

    const receiveMalformed = (rawTurnId: unknown, error: Error): void => {
      if (typeof rawTurnId !== 'string') return
      if (turnId !== undefined) {
        if (rawTurnId === turnId) failTurn(error)
        return
      }
      const eventBytes = Buffer.byteLength(rawTurnId, 'utf8') + 128
      if (!reserveEvent(eventBytes)) return
      bufferedMalformed.push({ turnId: rawTurnId, error })
      bufferedBytes += eventBytes
    }

    const handleDelta = (params: unknown): void => {
      if (!isRecord(params) || params.threadId !== thread.threadId) return
      if (turnId !== undefined && params.turnId !== turnId) return
      const parsed = agentMessageDeltaSchema.safeParse(params)
      if (parsed.success) {
        receive({ type: 'delta', value: parsed.data })
      } else {
        receiveMalformed(
          params.turnId,
          new ProviderNonRetryableError('Codex emitted an invalid message delta')
        )
      }
    }
    const handleCompleted = (params: unknown): void => {
      if (!isRecord(params) || params.threadId !== thread.threadId) return
      const rawTurnId = isRecord(params.turn) ? params.turn.id : undefined
      if (turnId !== undefined && rawTurnId !== turnId) return
      const parsed = turnCompletedSchema.safeParse(params)
      if (parsed.success) {
        receive({ type: 'completed', value: parsed.data })
      } else {
        receiveMalformed(
          rawTurnId,
          new ProviderNonRetryableError('Codex emitted an invalid turn completion')
        )
      }
    }
    const handleItem = (
      params: unknown,
      schema: typeof itemStartedSchema | typeof itemCompletedSchema
    ): void => {
      if (!isRecord(params) || params.threadId !== thread.threadId) return
      if (turnId !== undefined && params.turnId !== turnId) return
      const parsed = schema.safeParse(params)
      if (parsed.success) {
        receive({
          type: 'item',
          lifecycle: schema === itemCompletedSchema ? 'completed' : 'started',
          value: parsed.data
        })
      } else {
        receiveMalformed(
          params.turnId,
          new ProviderNonRetryableError('Codex emitted an invalid item lifecycle event')
        )
      }
    }
    const handleUsage = (params: unknown): void => {
      if (!isRecord(params) || params.threadId !== thread.threadId) return
      if (turnId !== undefined && params.turnId !== turnId) return
      const parsed = threadTokenUsageUpdatedSchema.safeParse(params)
      if (parsed.success) {
        receive({ type: 'usage', value: parsed.data })
      } else {
        receiveMalformed(
          params.turnId,
          new ProviderNonRetryableError('Codex emitted invalid usage data')
        )
      }
    }
    const removeDelta = client.onNotification(
      'item/agentMessage/delta',
      handleDelta
    )
    const removeCompleted = client.onNotification(
      'turn/completed',
      handleCompleted
    )
    const removeItemStarted = client.onNotification('item/started', (params) =>
      handleItem(params, itemStartedSchema)
    )
    const removeItemCompleted = client.onNotification('item/completed', (params) =>
      handleItem(params, itemCompletedSchema)
    )
    const removeUsage = client.onNotification('thread/tokenUsage/updated', handleUsage)

    let active: ActiveTurn | undefined
    const interrupt = (): void => {
      if (active === undefined || active.interruptSent) return
      active.interruptSent = true
      void active.client
        .request(
          'turn/interrupt',
          { threadId: active.threadId, turnId: active.turnId },
          emptyResponseSchema
        )
        .catch(() => undefined)
    }
    const handleAbort = (): void => {
      if (completed) return
      interrupt()
      queue.fail(safeAbortError(signal))
    }

    try {
      this.throwIfStopped(signal, state)
      const response = await client.request(
        'turn/start',
        {
          threadId: thread.threadId,
          input: [{ type: 'text', text: renderInput(request), text_elements: [] }],
          cwd: thread.cwd,
          approvalPolicy: 'never',
          model: config.model,
          effort: config.effort,
          outputSchema: DEBATE_OUTPUT_SCHEMA
        },
        turnStartResponseSchema
      )
      this.throwIfClientFailed(client)
      turnId = response.turn.id
      active = {
        client,
        threadId: thread.threadId,
        turnId,
        interruptSent: false,
        fail: (error) => queue.fail(error)
      }
      state.active = active
      this.activeTurns.set(config.roleId, active)
      signal.addEventListener('abort', handleAbort, { once: true })
      timeout = setTimeout(() => {
        interrupt()
        queue.fail(new ProviderRetryableError('Codex turn timed out'))
      }, this.turnTimeoutMs)
      const malformedCurrent = bufferedMalformed.find((event) => event.turnId === turnId)
      bufferedMalformed.length = 0
      if (malformedCurrent !== undefined) failTurn(malformedCurrent.error)
      for (const event of buffered.splice(0)) dispatch(event)
      bufferedBytes = 0
      if (signal.aborted || state.cancelled) {
        interrupt()
        queue.fail(signal.aborted ? safeAbortError(signal) : (state.cancellationError as Error))
      }

      while (true) {
        const next = await queue.next()
        if (next.done) break
        if (next.value.type === 'delta') {
          yield { type: 'content', content: next.value.value.delta }
        } else if (next.value.type === 'usage') {
          yield { type: 'usage', usage: next.value.value }
        } else {
          yield { type: 'final', finishReason: 'stop' }
        }
      }
    } catch (error) {
      if (!completed) interrupt()
      throw normalizeError(error, signal)
    } finally {
      if (!completed) interrupt()
      if (timeout !== undefined) clearTimeout(timeout)
      signal.removeEventListener('abort', handleAbort)
      removeDelta()
      removeCompleted()
      removeItemStarted()
      removeItemCompleted()
      removeUsage()
      if (this.turnStates.get(config.roleId) === state) this.turnStates.delete(config.roleId)
      if (this.activeTurns.get(config.roleId) === active) this.activeTurns.delete(config.roleId)
      await this.removeEmptyCwd(thread.cwd).catch(() => undefined)
    }
  }

  async cancelActive(): Promise<void> {
    const cancellationError = new DOMException('Stopped', 'AbortError')
    for (const state of this.turnStates.values()) {
      state.cancelled = true
      state.cancellationError ??= cancellationError
      state.active?.fail(state.cancellationError)
    }
    await Promise.all(
      [...this.activeTurns.values()].map(async (active) => {
        if (active.interruptSent) return
        active.interruptSent = true
        try {
          await active.client.request(
            'turn/interrupt',
            { threadId: active.threadId, turnId: active.turnId },
            emptyResponseSchema
          )
        } catch {
          // Stop is best effort; the orchestrator still aborts its local stream.
        }
      })
    )
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const closingError = new ProviderNonRetryableError('Codex provider was closed')
    for (const active of this.activeTurns.values()) active.fail(closingError)
    const cancellation = this.cancelActive()
    for (const waiter of this.loginWaiters.values()) {
      waiter.reject(closingError)
    }
    this.loginWaiters.clear()
    this.completedLogins.clear()
    this.ignoredLoginIds.clear()
    this.loginAttemptActive = false
    this.activeLoginId = undefined
    await cancellation
    const connection = this.connection
    this.connection = undefined
    connection?.removeLoginListener()
    connection?.removeFailureListener()
    await connection?.client.dispose()
    await this.connectionPromise?.catch(() => undefined)
  }

  private async prepareThread(
    client: CodexJsonRpcClient,
    config: OpenAIRoleConfig,
    request: ProviderReplyRequest,
    signal: AbortSignal,
    state: TurnState
  ): Promise<RoleThread> {
    let cwd: string | undefined
    try {
      cwd = await this.createEmptyCwd(config.roleId)
      this.throwIfStopped(signal, state)
      const response = await client.request(
        'thread/start',
        {
          model: config.model,
          cwd,
          approvalPolicy: 'never',
          baseInstructions: request.view.system,
          developerInstructions:
            'Debate-only text role. Never use tools, shell, files, commands, approvals, skills, MCP, apps, or network access. Return only the required JSON object.',
          ephemeral: true,
          serviceName: 'ai_debates'
        },
        threadStartResponseSchema
      )
      this.throwIfClientFailed(client)
      this.throwIfStopped(signal, state)
      if (
        response.model !== config.model ||
        response.cwd !== cwd ||
        response.approvalPolicy !== 'never' ||
        response.sandbox.type !== 'readOnly' ||
        response.sandbox.networkAccess !== false
      ) {
        throw new ProviderNonRetryableError('Codex did not apply the required safety policy')
      }
      const thread: RoleThread = {
        threadId: response.thread.id,
        cwd
      }
      return thread
    } catch (error) {
      if (cwd !== undefined) await this.removeEmptyCwd(cwd).catch(() => undefined)
      throw normalizeError(error, signal)
    }
  }

  private throwIfStopped(signal: AbortSignal, state: TurnState): void {
    if (signal.aborted) throw safeAbortError(signal)
    if (state.cancelled) {
      throw state.cancellationError ?? new DOMException('Stopped', 'AbortError')
    }
  }

  private handleLoginCompleted(params: unknown): void {
    const parsed = loginCompletedSchema.safeParse(params)
    if (!parsed.success || typeof parsed.data.loginId !== 'string') return
    if (this.ignoredLoginIds.delete(parsed.data.loginId)) return
    if (
      this.activeLoginId !== undefined &&
      parsed.data.loginId !== this.activeLoginId
    ) {
      return
    }
    if (this.loginWaiters.has(parsed.data.loginId)) {
      this.settleLogin(parsed.data.loginId, parsed.data)
    } else if (
      this.loginAttemptActive &&
      (this.activeLoginId === undefined || this.activeLoginId === parsed.data.loginId) &&
      this.completedLogins.size < 8
    ) {
      this.completedLogins.set(parsed.data.loginId, parsed.data)
    }
  }

  private settleLogin(loginId: string, completed: LoginCompleted): void {
    const waiter = this.loginWaiters.get(loginId)
    if (waiter === undefined) return
    this.loginWaiters.delete(loginId)
    this.completedLogins.delete(loginId)
    if (this.activeLoginId === loginId) {
      this.loginAttemptActive = false
      this.activeLoginId = undefined
    }
    if (completed.success) waiter.resolve()
    else waiter.reject(new ProviderNonRetryableError('ChatGPT login did not complete'))
  }

  private ignoreLoginCompletion(loginId: string): void {
    if (this.ignoredLoginIds.size < 8) this.ignoredLoginIds.add(loginId)
  }

  private async getClient(): Promise<CodexJsonRpcClient> {
    this.ensureUsable()
    if (this.connection !== undefined) return this.connection.client
    if (this.connectionPromise !== undefined) return this.connectionPromise

    const connecting = (async (): Promise<CodexJsonRpcClient> => {
      const client = await this.dependencies.createClient()
      if (this.disposed) {
        await client.dispose()
        throw new ProviderNonRetryableError('Codex provider is closed')
      }
      let connection!: ProviderConnection
      const removeLoginListener = client.onNotification(
        'account/login/completed',
        (params) => this.handleLoginCompleted(params)
      )
      const removeFailureListener = client.onFailure((error) => {
        this.handleConnectionFailure(connection, error)
      })
      connection = { client, removeLoginListener, removeFailureListener }
      if (this.disposed) {
        removeLoginListener()
        removeFailureListener()
        await client.dispose()
        throw new ProviderNonRetryableError('Codex provider is closed')
      }
      this.connection = connection
      return client
    })()
    this.connectionPromise = connecting
    try {
      return await connecting
    } finally {
      if (this.connectionPromise === connecting) this.connectionPromise = undefined
    }
  }

  private handleConnectionFailure(connection: ProviderConnection, error: Error): void {
    const safe = normalizeError(error)
    this.failedClients.set(connection.client, safe)
    if (this.connection !== connection) return
    this.connection = undefined
    connection.removeLoginListener()
    connection.removeFailureListener()
    for (const active of this.activeTurns.values()) {
      if (active.client === connection.client) active.fail(safe)
    }
    for (const waiter of this.loginWaiters.values()) waiter.reject(safe)
    this.loginWaiters.clear()
    this.completedLogins.clear()
    this.ignoredLoginIds.clear()
    this.loginAttemptActive = false
    this.activeLoginId = undefined
    void connection.client.dispose()
  }

  private throwIfClientFailed(client: CodexJsonRpcClient): void {
    const failure = this.failedClients.get(client)
    if (failure !== undefined) throw failure
  }

  private ensureUsable(): void {
    if (this.disposed) throw new ProviderNonRetryableError('Codex provider is closed')
  }
}
