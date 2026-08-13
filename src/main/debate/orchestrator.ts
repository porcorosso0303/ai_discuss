import type {
  DebateEvent,
  DebateMessage,
  DebateSession,
  DebateSetup,
  RoleConfig,
  Usage
} from '../../shared/domain'
import { debateEventSchema, debateSetupSchema } from '../../shared/schemas'
import {
  ProviderRefusalError,
  isRetryableProviderError,
  type ProviderRegistry
} from '../providers/provider'
import { buildRoleView } from './prompt-builder'
import { parseReply } from './reply-parser'
import {
  createDebateMachine,
  reduceDebateState,
  type DebateMachineAction,
  type DebateMachineState
} from './state-machine'

export interface DebateRepository {
  saveSession(session: DebateSession): Promise<void>
}

export interface RetryPolicy {
  maxAttempts: number
  shouldRetry(error: unknown): boolean
}

export interface OrchestratorDependencies {
  registry: ProviderRegistry
  repository: DebateRepository
  clock?: () => Date
  idFactory?: () => string
  retryPolicy?: RetryPolicy
  onEvent?: (event: DebateEvent) => void
}

type DebateEventInput = DebateEvent extends infer Event
  ? Event extends DebateEvent
    ? Omit<Event, 'id' | 'sessionId' | 'createdAt'>
    : never
  : never

export class DebateOrchestrator {
  private machine?: DebateMachineState
  private createdAt?: string
  private abortController?: AbortController
  private drivePromise?: Promise<void>
  private saveQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private durableEvents: DebateEvent[] = []
  private readonly clock: () => Date
  private readonly idFactory: () => string
  private readonly retryPolicy: RetryPolicy

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.clock = dependencies.clock ?? (() => new Date())
    this.idFactory = dependencies.idFactory ?? (() => crypto.randomUUID())
    this.retryPolicy = dependencies.retryPolicy ?? {
      maxAttempts: 3,
      shouldRetry: isRetryableProviderError
    }
  }

  async start(input: DebateSetup): Promise<DebateSession> {
    if (this.machine !== undefined) {
      throw new Error('A debate session has already been started')
    }

    const setup = debateSetupSchema.parse(input)
    this.generation += 1
    this.createdAt = this.clock().toISOString()
    this.machine = createDebateMachine(this.idFactory(), setup)
    this.transition({ type: 'beginValidation' })

    for (const role of setup.roles) {
      try {
        await this.dependencies.registry[role.provider].discover(role)
      } catch (error) {
        this.emitProviderDiscoveryError(role, error)
        this.transition({ type: 'validationFailed' })
        await this.enqueueSave()
        throw error
      }
    }

    this.transition({ type: 'validationSucceeded' })
    await this.ensureDrive()
    return this.session()
  }

  getSession(): DebateSession {
    return this.session()
  }

  async pause(): Promise<DebateSession> {
    this.transition({ type: 'pauseRequested' })
    const paused = this.session()
    await this.enqueueSave(paused)
    return paused
  }

  async resume(): Promise<DebateSession> {
    if (!this.transition({ type: 'resume' })) {
      return this.session()
    }
    await this.ensureDrive()
    return this.session()
  }

  async stop(): Promise<DebateSession> {
    const provider = this.machine === undefined
      ? undefined
      : this.dependencies.registry[this.role(this.machine.currentSpeaker).provider]
    if (!this.transition({ type: 'stopRequested' })) {
      return this.session()
    }
    this.generation += 1
    this.abortController?.abort()
    await provider?.cancelActive?.()
    await this.enqueueSave()
    return this.session()
  }

  async retryCurrentTurn(): Promise<DebateSession> {
    if (!this.transition({ type: 'retryCurrentTurn' })) {
      return this.session()
    }
    this.generation += 1
    await this.ensureDrive()
    return this.session()
  }

  async finishFailed(): Promise<DebateSession> {
    this.transition({ type: 'finishFailed' })
    await this.enqueueSave()
    return this.session()
  }

  private async drive(): Promise<void> {
    while (this.requireMachine().phase === 'running') {
      await this.runCurrentTurn()
    }
  }

  private ensureDrive(): Promise<void> {
    if (this.drivePromise !== undefined) {
      return this.drivePromise
    }

    const running = this.drive()
    this.drivePromise = running
    running.then(
      () => {
        if (this.drivePromise === running) {
          this.drivePromise = undefined
        }
      },
      () => {
        if (this.drivePromise === running) {
          this.drivePromise = undefined
        }
      }
    )
    return running
  }

  private async runCurrentTurn(): Promise<void> {
    const before = this.requireMachine()
    const role = this.role(before.currentSpeaker)
    const turn = before.turnCount + 1
    this.transition({ type: 'turnStarted', roleId: role.roleId })
    this.emit({ type: 'turn-started', roleId: role.roleId, turn })

    const generation = this.generation
    let completedRaw: string | undefined
    let completedUsage: Usage | undefined

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      this.abortController = controller
      let raw = ''
      let usage: Usage | undefined
      let refused = false
      let draftVisible = false

      try {
        for await (const chunk of this.dependencies.registry[role.provider].streamReply(
          {
            sessionId: before.sessionId,
            turn,
            role,
            view: buildRoleView(this.session(), role.roleId)
          },
          controller.signal
        )) {
          if (generation !== this.generation) {
            return
          }

          if (chunk.type === 'content') {
            raw += chunk.content
            draftVisible ||= chunk.content.length > 0
            this.emit(
              { type: 'speech-delta', roleId: role.roleId, turn, delta: chunk.content },
              false
            )
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
            this.emit({ type: 'usage-updated', roleId: role.roleId, usage: chunk.usage })
          } else if (chunk.finishReason === 'refusal') {
            refused = true
          }
        }

        if (generation !== this.generation) {
          return
        }

        if (refused) {
          if (draftVisible) {
            this.emitSpeechReset(role, turn)
          }
          this.emitProviderError(role, turn, attempt, false, '模型明确拒绝继续发言')
          this.transition({ type: 'turnRefused' })
          await this.enqueueSave()
          return
        }

        completedRaw = raw
        completedUsage = usage
        break
      } catch (error) {
        if (
          generation !== this.generation ||
          (controller.signal.aborted && this.requireMachine().phase === 'stopped')
        ) {
          return
        }

        const refusedByError = error instanceof ProviderRefusalError
        const retryable = !refusedByError && this.retryPolicy.shouldRetry(error)
        this.emitProviderError(role, turn, attempt, retryable, this.errorMessage(error))
        if (draftVisible) {
          this.emitSpeechReset(role, turn)
        }

        if (refusedByError) {
          this.transition({ type: 'turnRefused' })
          await this.enqueueSave()
          return
        }

        if (!retryable || attempt === this.retryPolicy.maxAttempts) {
          this.transition({ type: 'turnFailed' })
          await this.enqueueSave()
          return
        }
      } finally {
        if (this.abortController === controller) {
          this.abortController = undefined
        }
      }
    }

    if (completedRaw === undefined) {
      return
    }

    const parsed = parseReply(completedRaw)
    const message: DebateMessage = {
      id: this.idFactory(),
      turn,
      roleId: role.roleId,
      provider: role.provider,
      model: role.model,
      speech: parsed.speech,
      status: parsed.status,
      createdAt: this.clock().toISOString(),
      ...(completedUsage === undefined ? {} : { usage: completedUsage })
    }
    this.transition({ type: 'turnCompleted', message }, false)
    this.emit({ type: 'message-completed', message })
    this.emitStateIfTerminal()
    await this.enqueueSave()
  }

  private role(roleId: RoleConfig['roleId']): RoleConfig {
    const role = this.requireMachine().setup.roles.find((candidate) => candidate.roleId === roleId)
    if (role === undefined) {
      throw new Error(`Role ${roleId} is not configured`)
    }
    return role
  }

  private transition(action: DebateMachineAction, emitState = true): boolean {
    const previous = this.requireMachine().phase
    const result = reduceDebateState(this.requireMachine(), action)
    this.machine = result.state
    if (emitState && previous !== result.state.phase) {
      this.emit({ type: 'state-changed', state: result.state.phase })
    }
    return result.warning === undefined
  }

  private emitStateIfTerminal(): void {
    const state = this.requireMachine().phase
    if (state !== 'running') {
      this.emit({ type: 'state-changed', state })
    }
  }

  private emit(input: DebateEventInput, durable = true): void {
    const event = debateEventSchema.parse({
      ...input,
      id: this.idFactory(),
      sessionId: this.requireMachine().sessionId,
      createdAt: this.clock().toISOString()
    })
    if (durable) {
      this.durableEvents = [...this.durableEvents, event]
    }
    this.dependencies.onEvent?.(event)
  }

  private emitProviderError(
    role: RoleConfig,
    turn: number,
    attempt: number,
    retryable: boolean,
    message: string
  ): void {
    this.emit({
      type: 'warning',
      code: 'provider-error',
      roleId: role.roleId,
      turn,
      message,
      retryable,
      attempt
    })
  }

  private emitSpeechReset(role: RoleConfig, turn: number): void {
    this.emit({ type: 'speech-reset', roleId: role.roleId, turn }, false)
  }

  private emitProviderDiscoveryError(role: RoleConfig, error: unknown): void {
    this.emit({
      type: 'warning',
      code: 'provider-discovery-error',
      roleId: role.roleId,
      message: this.errorMessage(error),
      retryable: this.retryPolicy.shouldRetry(error)
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim() !== ''
      ? error.message.slice(0, 4000)
      : 'Provider call failed'
  }

  private enqueueSave(session = this.session()): Promise<void> {
    const snapshot = structuredClone(session)
    const queued = this.saveQueue.then(() => this.dependencies.repository.saveSession(snapshot))
    this.saveQueue = queued.catch(() => undefined)
    return queued
  }

  private requireMachine(): DebateMachineState {
    if (this.machine === undefined) {
      throw new Error('No debate session has been started')
    }
    return this.machine
  }

  private session(): DebateSession {
    const machine = this.requireMachine()
    const now = this.clock().toISOString()
    return {
      id: machine.sessionId,
      setup: machine.setup,
      state: machine.phase,
      messages: machine.messages,
      events: this.durableEvents,
      currentTurn: machine.turnCount,
      createdAt: this.createdAt ?? now,
      updatedAt: now,
      ...(machine.winnerRoleId === undefined ? {} : { winnerRoleId: machine.winnerRoleId }),
      ...(machine.terminationReason === undefined
        ? {}
        : { terminationReason: machine.terminationReason }),
      contextCompressed: false
    }
  }
}
