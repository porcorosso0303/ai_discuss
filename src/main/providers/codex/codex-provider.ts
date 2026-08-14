import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ModelCapability,
  OpenAIRoleConfig,
  ProviderCapabilities,
  ReasoningEffort,
  RoleConfig,
  RoleId
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
  loginCompletedSchema,
  loginStartResponseSchema,
  modelListResponseSchema,
  threadStartResponseSchema,
  turnCompletedSchema,
  turnStartResponseSchema,
  type AgentMessageDelta,
  type CodexModel,
  type LoginCompleted,
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
const DEFAULT_TURN_TIMEOUT_MS = 180_000

interface RoleThread {
  roleId: RoleId
  sessionId: string
  threadId: string
  cwd: string
  model: string
  effort: ReasoningEffort
}

interface ActiveTurn {
  threadId: string
  turnId: string
  interruptSent: boolean
  fail: (error: Error) => void
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
  client: CodexJsonRpcClient
  openExternal: (url: string) => Promise<unknown>
  createEmptyCwd?: (roleId: RoleId) => Promise<string>
  removeEmptyCwd?: (path: string) => Promise<void>
  turnTimeoutMs?: number
}

class AsyncEventQueue<Event> {
  private values: Event[] = []
  private waiter:
    | { resolve: (value: IteratorResult<Event>) => void; reject: (error: Error) => void }
    | undefined
  private closed = false
  private failure: Error | undefined

  push(value: Event): void {
    if (this.closed || this.failure !== undefined) return
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve({ value, done: false })
    } else {
      this.values.push(value)
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
    if (this.waiter !== undefined) {
      const waiter = this.waiter
      this.waiter = undefined
      waiter.reject(error)
    }
  }

  next(): Promise<IteratorResult<Event>> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }
}

type TurnEvent =
  | { type: 'delta'; value: AgentMessageDelta }
  | { type: 'completed'; value: TurnCompleted }

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
  if (error instanceof JsonRpcProtocolError || error instanceof JsonRpcServerError) {
    return new ProviderNonRetryableError('Codex App Server rejected an invalid operation')
  }
  return new ProviderNonRetryableError('Codex App Server response was invalid')
}

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
  private readonly threads = new Map<RoleId, RoleThread>()
  private readonly activeTurns = new Map<RoleId, ActiveTurn>()
  private readonly reservedRoles = new Set<RoleId>()
  private readonly loginWaiters = new Map<string, LoginWaiter>()
  private readonly completedLogins = new Map<string, LoginCompleted>()
  private readonly removeLoginListener: () => void
  private readonly removeFailureListener: () => void
  private disposed = false
  private connectionFailure: Error | undefined
  private loginAttemptActive = false

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
    this.removeLoginListener = dependencies.client.onNotification(
      'account/login/completed',
      (params) => this.handleLoginCompleted(params)
    )
    this.removeFailureListener = dependencies.client.onFailure((error) => {
      const safe = normalizeError(error)
      this.connectionFailure = safe
      for (const active of this.activeTurns.values()) active.fail(safe)
      for (const waiter of this.loginWaiters.values()) waiter.reject(safe)
      this.loginWaiters.clear()
      this.loginAttemptActive = false
    })
  }

  async readAccount(): Promise<CodexAccountStatus> {
    this.ensureUsable()
    try {
      const response = await this.dependencies.client.request(
        'account/read',
        { refreshToken: false },
        accountReadResponseSchema
      )
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
    try {
      const response = await this.dependencies.client.request(
        'account/login/start',
        { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'chatgpt' },
        loginStartResponseSchema
      )
      if (!isAllowedLoginUrl(response.authUrl)) {
        void this.dependencies.client
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
      if (completed !== undefined) {
        this.completedLogins.delete(response.loginId)
        this.settleLogin(response.loginId, completed)
      }
      try {
        await this.dependencies.openExternal(response.authUrl)
      } catch {
        this.loginWaiters.delete(response.loginId)
        void this.dependencies.client
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
      throw normalizeError(error)
    }
  }

  async cancelChatGptLogin(loginId: string): Promise<void> {
    this.ensureUsable()
    try {
      await this.dependencies.client.request(
        'account/login/cancel',
        { loginId },
        cancelLoginResponseSchema
      )
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async logout(): Promise<void> {
    this.ensureUsable()
    try {
      await this.dependencies.client.request('account/logout', undefined, emptyResponseSchema)
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
        const response = await this.dependencies.client.request(
          'model/list',
          params,
          modelListResponseSchema
        )
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
    try {
      config = openAIRoleConfigSchema.parse(request.role)
      const capability = this.capabilitiesByRole.get(config.roleId)?.get(config.model)
      if (capability === undefined || !capability.reasoningEfforts.includes(config.effort)) {
        throw new ProviderNonRetryableError('Codex model capabilities must be validated first')
      }
      if (signal.aborted) throw safeAbortError(signal)
      if (this.activeTurns.has(config.roleId) || this.reservedRoles.has(config.roleId)) {
        throw new ProviderNonRetryableError('This Codex role already has an active turn')
      }
      this.reservedRoles.add(config.roleId)
    } catch (error) {
      throw normalizeError(error, signal)
    }

    let thread: RoleThread
    try {
      thread = await this.ensureThread(config, request)
    } catch (error) {
      this.reservedRoles.delete(config.roleId)
      throw normalizeError(error, signal)
    }
    const queue = new AsyncEventQueue<TurnEvent>()
    const buffered: TurnEvent[] = []
    let turnId: string | undefined
    let visibleChars = 0
    let completed = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const receive = (event: TurnEvent): void => {
      if (turnId === undefined) {
        buffered.push(event)
        return
      }
      const eventThreadId = event.value.threadId
      const eventTurnId =
        event.type === 'delta' ? event.value.turnId : event.value.turn.id
      if (eventThreadId !== thread.threadId || eventTurnId !== turnId) return
      if (completed) return
      if (event.type === 'delta') {
        if (visibleChars + event.value.delta.length > MAX_VISIBLE_CONTENT_CHARS) {
          queue.fail(new ProviderNonRetryableError('Codex visible response exceeds the safe limit'))
          return
        }
        visibleChars += event.value.delta.length
        queue.push(event)
        return
      }
      completed = true
      if (event.value.turn.status !== 'completed') {
        queue.fail(new ProviderNonRetryableError('Codex turn did not complete successfully'))
      } else if (visibleChars === 0) {
        queue.fail(new ProviderNonRetryableError('Codex completed without a visible response'))
      } else {
        queue.push(event)
        queue.close()
      }
    }

    const handleDelta = (params: unknown): void => {
      const parsed = agentMessageDeltaSchema.safeParse(params)
      if (parsed.success) {
        receive({ type: 'delta', value: parsed.data })
      } else if (isRecord(params) && params.threadId === thread.threadId) {
        queue.fail(new ProviderNonRetryableError('Codex emitted an invalid message delta'))
      }
    }
    const handleCompleted = (params: unknown): void => {
      const parsed = turnCompletedSchema.safeParse(params)
      if (parsed.success) {
        receive({ type: 'completed', value: parsed.data })
      } else if (isRecord(params) && params.threadId === thread.threadId) {
        queue.fail(new ProviderNonRetryableError('Codex emitted an invalid turn completion'))
      }
    }
    const removeDelta = this.dependencies.client.onNotification(
      'item/agentMessage/delta',
      handleDelta
    )
    const removeCompleted = this.dependencies.client.onNotification(
      'turn/completed',
      handleCompleted
    )

    let active: ActiveTurn | undefined
    const interrupt = (): void => {
      if (active === undefined || active.interruptSent) return
      active.interruptSent = true
      void this.dependencies.client
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
      const response = await this.dependencies.client.request(
        'turn/start',
        {
          threadId: thread.threadId,
          input: [{ type: 'text', text: renderInput(request), text_elements: [] }],
          cwd: thread.cwd,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          model: config.model,
          effort: config.effort,
          outputSchema: DEBATE_OUTPUT_SCHEMA
        },
        turnStartResponseSchema
      )
      if (this.connectionFailure !== undefined) throw this.connectionFailure
      turnId = response.turn.id
      active = {
        threadId: thread.threadId,
        turnId,
        interruptSent: false,
        fail: (error) => queue.fail(error)
      }
      this.activeTurns.set(config.roleId, active)
      this.reservedRoles.delete(config.roleId)
      signal.addEventListener('abort', handleAbort, { once: true })
      timeout = setTimeout(() => {
        interrupt()
        queue.fail(new ProviderRetryableError('Codex turn timed out'))
      }, this.turnTimeoutMs)
      for (const event of buffered.splice(0)) receive(event)
      if (signal.aborted) handleAbort()

      while (true) {
        const next = await queue.next()
        if (next.done) break
        if (next.value.type === 'delta') {
          yield { type: 'content', content: next.value.value.delta }
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
      this.reservedRoles.delete(config.roleId)
      if (this.activeTurns.get(config.roleId) === active) this.activeTurns.delete(config.roleId)
    }
  }

  async cancelActive(): Promise<void> {
    await Promise.all(
      [...this.activeTurns.values()].map(async (active) => {
        if (active.interruptSent) return
        active.interruptSent = true
        try {
          await this.dependencies.client.request(
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
    this.removeLoginListener()
    this.removeFailureListener()
    for (const waiter of this.loginWaiters.values()) {
      waiter.reject(closingError)
    }
    this.loginWaiters.clear()
    this.loginAttemptActive = false
    await this.dependencies.client.dispose()
    await cancellation
    await Promise.all(
      [...this.threads.values()].map(({ cwd }) =>
        this.removeEmptyCwd(cwd).catch(() => undefined)
      )
    )
    this.threads.clear()
  }

  private async ensureThread(
    config: OpenAIRoleConfig,
    request: ProviderReplyRequest
  ): Promise<RoleThread> {
    const existing = this.threads.get(config.roleId)
    if (existing !== undefined) {
      if (
        existing.sessionId !== request.sessionId ||
        existing.model !== config.model ||
        existing.effort !== config.effort
      ) {
        throw new ProviderNonRetryableError(
          'Codex role configuration cannot change while its debate thread is active'
        )
      }
      return existing
    }
    if (this.threads.size >= 2) {
      throw new ProviderNonRetryableError('Codex role thread limit exceeded')
    }
    let cwd: string | undefined
    try {
      cwd = await this.createEmptyCwd(config.roleId)
      const response = await this.dependencies.client.request(
        'thread/start',
        {
          model: config.model,
          cwd,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: request.view.system,
          developerInstructions:
            'Debate-only text role. Never use tools, shell, files, commands, approvals, skills, MCP, apps, or network access. Return only the required JSON object.',
          ephemeral: true,
          serviceName: 'ai_debates'
        },
        threadStartResponseSchema
      )
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
        roleId: config.roleId,
        sessionId: request.sessionId,
        threadId: response.thread.id,
        cwd,
        model: config.model,
        effort: config.effort
      }
      this.threads.set(config.roleId, thread)
      return thread
    } catch (error) {
      if (cwd !== undefined) await this.removeEmptyCwd(cwd).catch(() => undefined)
      throw normalizeError(error)
    }
  }

  private handleLoginCompleted(params: unknown): void {
    const parsed = loginCompletedSchema.safeParse(params)
    if (!parsed.success || parsed.data.loginId === null) return
    if (this.loginWaiters.has(parsed.data.loginId)) {
      this.settleLogin(parsed.data.loginId, parsed.data)
    } else if (this.completedLogins.size < 8) {
      this.completedLogins.set(parsed.data.loginId, parsed.data)
    }
  }

  private settleLogin(loginId: string, completed: LoginCompleted): void {
    const waiter = this.loginWaiters.get(loginId)
    if (waiter === undefined) return
    this.loginWaiters.delete(loginId)
    this.loginAttemptActive = false
    if (completed.success) waiter.resolve()
    else waiter.reject(new ProviderNonRetryableError('ChatGPT login did not complete'))
  }

  private ensureUsable(): void {
    if (this.disposed) throw new ProviderNonRetryableError('Codex provider is closed')
    if (this.connectionFailure !== undefined) throw this.connectionFailure
  }
}
