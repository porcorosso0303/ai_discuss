import type {
  DebateSession,
  ProviderCapabilities,
  RoleConfig
} from '../../src/shared/domain'
import type {
  DebateProvider,
  ProviderChunk,
  ProviderReplyRequest
} from '../../src/main/providers/provider'
import type { DebateRepository, OrchestratorDependencies } from '../../src/main/debate/orchestrator'

export interface FakeProviderScript {
  chunks?: ProviderChunk[]
  error?: Error
  onStart?: (request: ProviderReplyRequest) => void
  waitAt?: number
  ignoreAbort?: boolean
}

interface Gate {
  promise: Promise<void>
  release: () => void
}

const gate = (): Gate => {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const abortError = (): Error => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export class FakeProvider implements DebateProvider {
  readonly requests: ProviderReplyRequest[] = []
  readonly discoverCalls: RoleConfig[] = []
  cancelCalls = 0
  private readonly callWaiters: Array<() => void> = []
  private readonly gates = new Map<number, Gate>()

  constructor(private readonly scripts: FakeProviderScript[]) {}

  async discover(config: RoleConfig, _signal?: AbortSignal): Promise<ProviderCapabilities> {
    this.discoverCalls.push(config)
    return {
      provider: config.provider,
      models: [
        {
          id: config.model,
          reasoningEfforts: [],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-object']
        }
      ],
      defaultModel: config.model
    }
  }

  async *streamReply(
    request: ProviderReplyRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderChunk> {
    const callIndex = this.requests.length
    const script = this.scripts[callIndex]
    const pendingGate = script?.waitAt === undefined ? undefined : gate()
    if (pendingGate !== undefined) {
      this.gates.set(callIndex, pendingGate)
    }
    this.requests.push(request)
    script?.onStart?.(request)
    this.callWaiters.splice(0).forEach((resolve) => resolve())

    if (script === undefined) {
      throw new Error(`No fake provider script for call ${callIndex + 1}`)
    }

    const chunks = script.chunks ?? []
    for (let index = 0; index < chunks.length; index += 1) {
      if (script.waitAt === index) {
        if (pendingGate === undefined) {
          throw new Error(`Missing fake provider gate for call ${callIndex + 1}`)
        }
        if (!script.ignoreAbort) {
          signal.addEventListener('abort', pendingGate.release, { once: true })
        }
        await pendingGate.promise
      }

      if (signal.aborted && !script.ignoreAbort) {
        throw abortError()
      }

      const chunk = chunks[index]
      if (chunk !== undefined) {
        yield chunk
      }
    }

    if (script.error !== undefined) {
      throw script.error
    }
  }

  async waitForCalls(count: number): Promise<void> {
    while (this.requests.length < count) {
      await new Promise<void>((resolve) => this.callWaiters.push(resolve))
    }
  }

  releaseCall(index: number): void {
    this.gates.get(index)?.release()
  }

  cancelActive(): void {
    this.cancelCalls += 1
  }
}

export class FakeDebateRepository implements DebateRepository {
  readonly saved: DebateSession[] = []

  async saveSession(session: DebateSession): Promise<void> {
    this.saved.push(structuredClone(session))
  }
}

export class DeferredDebateRepository implements DebateRepository {
  readonly started: DebateSession[] = []
  readonly saved: DebateSession[] = []
  activeSaves = 0
  maxConcurrentSaves = 0
  private readonly saveWaiters: Array<() => void> = []
  private readonly releaseWaiters: Array<(() => void) | undefined> = []

  async saveSession(session: DebateSession): Promise<void> {
    const snapshot = structuredClone(session)
    this.started.push(snapshot)
    this.activeSaves += 1
    this.maxConcurrentSaves = Math.max(this.maxConcurrentSaves, this.activeSaves)
    this.saveWaiters.splice(0).forEach((resolve) => resolve())

    await new Promise<void>((resolve) => this.releaseWaiters.push(resolve))

    this.saved.push(snapshot)
    this.activeSaves -= 1
  }

  async waitForStarted(count: number): Promise<void> {
    while (this.started.length < count) {
      await new Promise<void>((resolve) => this.saveWaiters.push(resolve))
    }
  }

  releaseNext(): void {
    const index = this.releaseWaiters.findIndex((resolve) => resolve !== undefined)
    if (index !== -1) {
      this.release(index)
    }
  }

  release(index: number): void {
    const resolve = this.releaseWaiters[index]
    this.releaseWaiters[index] = undefined
    resolve?.()
  }
}

export class FirstSaveDeferredRepository implements DebateRepository {
  readonly started: DebateSession[] = []
  readonly saved: DebateSession[] = []
  activeSaves = 0
  maxConcurrentSaves = 0
  private releaseFirstSave = (): void => undefined
  private firstSaveStarted = Promise.resolve()

  constructor() {
    this.firstSaveStarted = new Promise<void>((resolveStarted) => {
      this.releaseFirstSave = (): void => undefined
      this.resolveFirstStarted = resolveStarted
    })
  }

  private resolveFirstStarted = (): void => undefined

  async saveSession(session: DebateSession): Promise<void> {
    const snapshot = structuredClone(session)
    const index = this.started.length
    this.started.push(snapshot)
    this.activeSaves += 1
    this.maxConcurrentSaves = Math.max(this.maxConcurrentSaves, this.activeSaves)

    if (index === 0) {
      const blocked = new Promise<void>((resolve) => {
        this.releaseFirstSave = resolve
      })
      this.resolveFirstStarted()
      await blocked
    }

    this.saved.push(snapshot)
    this.activeSaves -= 1
  }

  async waitForFirstSave(): Promise<void> {
    await this.firstSaveStarted
  }

  releaseFirst(): void {
    this.releaseFirstSave()
  }
}

export class FirstSaveRejectingRepository implements DebateRepository {
  readonly saved: DebateSession[] = []
  calls = 0

  async saveSession(session: DebateSession): Promise<void> {
    this.calls += 1
    if (this.calls === 1) {
      throw new Error('simulated repository failure')
    }
    this.saved.push(structuredClone(session))
  }
}

export const deterministicDependencies = (): Pick<
  OrchestratorDependencies,
  'clock' | 'idFactory' | 'retrySleep' | 'retryNow' | 'retryRandom'
> => {
  let id = 0
  return {
    clock: () => new Date('2026-08-12T00:00:00.000Z'),
    idFactory: () => `generated-${++id}`,
    retrySleep: async () => undefined,
    retryNow: () => Date.parse('2026-08-12T00:00:00.000Z'),
    retryRandom: () => 0.5
  }
}
