import type {
  DebateMessage,
  DebateSession,
  DebateSetup,
  OrchestratorEvent,
  RoleConfig,
  Usage
} from '../../shared/domain'
import { debateSetupSchema, orchestratorEventSchema } from '../../shared/schemas'
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
  onEvent?: (event: OrchestratorEvent) => void
}

export class DebateOrchestrator {
  private machine?: DebateMachineState
  private createdAt?: string
  private abortController?: AbortController
  private generation = 0
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
      await this.dependencies.registry[role.provider].discover(role)
    }

    this.transition({ type: 'validationSucceeded' })
    await this.drive()
    return this.session()
  }

  getSession(): DebateSession {
    return this.session()
  }

  pause(): DebateSession {
    this.transition({ type: 'pauseRequested' })
    return this.session()
  }

  async resume(): Promise<DebateSession> {
    if (!this.transition({ type: 'resume' })) {
      return this.session()
    }
    await this.drive()
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
    await this.dependencies.repository.saveSession(this.session())
    return this.session()
  }

  async retryCurrentTurn(): Promise<DebateSession> {
    if (!this.transition({ type: 'retryCurrentTurn' })) {
      return this.session()
    }
    this.generation += 1
    await this.drive()
    return this.session()
  }

  async finishFailed(): Promise<DebateSession> {
    this.transition({ type: 'finishFailed' })
    await this.dependencies.repository.saveSession(this.session())
    return this.session()
  }

  private async drive(): Promise<void> {
    while (this.requireMachine().phase === 'running') {
      await this.runCurrentTurn()
    }
  }

  private async runCurrentTurn(): Promise<void> {
    const before = this.requireMachine()
    const role = this.role(before.currentSpeaker)
    const turn = before.turnCount + 1
    this.transition({ type: 'turnStarted', roleId: role.roleId })
    this.emit({ type: 'turnStarted', roleId: role.roleId, turn })

    const generation = this.generation
    let completedRaw: string | undefined
    let completedUsage: Usage | undefined

    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      this.abortController = controller
      let raw = ''
      let usage: Usage | undefined
      let refused = false

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
            this.emit({ type: 'chunk', roleId: role.roleId, turn, content: chunk.content })
          } else if (chunk.type === 'usage') {
            usage = chunk.usage
          } else if (chunk.finishReason === 'refusal') {
            refused = true
          }
        }

        if (generation !== this.generation) {
          return
        }

        if (refused) {
          this.emitProviderError(role, turn, attempt, false, '模型明确拒绝继续发言')
          this.transition({ type: 'turnRefused' })
          await this.dependencies.repository.saveSession(this.session())
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

        if (refusedByError) {
          this.transition({ type: 'turnRefused' })
          await this.dependencies.repository.saveSession(this.session())
          return
        }

        if (!retryable || attempt === this.retryPolicy.maxAttempts) {
          this.transition({ type: 'turnFailed' })
          await this.dependencies.repository.saveSession(this.session())
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
    this.emit({ type: 'turnCompleted', message })
    await this.dependencies.repository.saveSession(this.session())
    this.emitStateIfTerminal()
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
      this.emit({ type: 'stateChanged', state: result.state.phase })
    }
    return result.warning === undefined
  }

  private emitStateIfTerminal(): void {
    const state = this.requireMachine().phase
    if (state !== 'running') {
      this.emit({ type: 'stateChanged', state })
    }
  }

  private emit(event: OrchestratorEvent): void {
    this.dependencies.onEvent?.(orchestratorEventSchema.parse(event))
  }

  private emitProviderError(
    role: RoleConfig,
    turn: number,
    attempt: number,
    retryable: boolean,
    message: string
  ): void {
    this.emit({
      type: 'error',
      roleId: role.roleId,
      turn,
      message,
      retryable,
      attempt
    })
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim() !== ''
      ? error.message.slice(0, 4000)
      : 'Provider call failed'
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
      events: [],
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
