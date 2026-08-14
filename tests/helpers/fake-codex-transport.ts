import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import type { CodexProcessTransport } from '../../src/main/providers/codex/jsonrpc-client'

export type FakeCodexMode =
  | 'normal'
  | 'exit'
  | 'malformed'
  | 'oversized'
  | 'stderr'
  | 'login-failed'
  | 'api-key-account'
  | 'duplicate-models'
  | 'malformed-catalog'
  | 'malformed-thread'
  | 'turn-failed'
  | 'turn-interrupted'
  | 'empty-turn'
  | 'malformed-delta'
  | 'oversized-delta'
  | 'crash-active'
  | 'duplicate-completion'
  | 'out-of-order'

export interface FakeCodexTransportOptions {
  mode?: FakeCodexMode
  authUrl?: string
  secret?: string
}

export class FakeCodexTransport extends EventEmitter implements CodexProcessTransport {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly transcript: Array<Record<string, any>> = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private readonly mode: FakeCodexMode
  private initialized = false
  private threadCounter = 0
  private turnCounter = 0
  private inputBuffer = ''

  constructor(private readonly options: FakeCodexTransportOptions = {}) {
    super()
    this.mode = options.mode ?? 'normal'
    this.stdin.on('data', (chunk) => this.receive(chunk.toString('utf8')))
    queueMicrotask(() => {
      if (this.mode === 'oversized') this.stdout.write(`${'x'.repeat(2048)}\n`)
      if (this.mode === 'malformed') this.stdout.write('{not-json}\n')
      if (this.mode === 'stderr') {
        this.stderr.write(`Bearer ${options.secret ?? 'secret'} ${'x'.repeat(2048)}`)
      }
    })
  }

  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.exitCode = 0
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', 0, null))
    return true
  }

  private receive(chunk: string): void {
    this.inputBuffer += chunk
    let newline = this.inputBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.inputBuffer.slice(0, newline)
      this.inputBuffer = this.inputBuffer.slice(newline + 1)
      if (line !== '') this.handle(JSON.parse(line) as Record<string, any>)
      newline = this.inputBuffer.indexOf('\n')
    }
  }

  private send(value: unknown): void {
    if (!this.stdout.destroyed) this.stdout.write(`${JSON.stringify(value)}\n`)
  }

  private crash(code: number): void {
    this.exitCode = code
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
  }

  private handle(message: Record<string, any>): void {
    this.transcript.push(message)
    if (message.method === 'initialize') {
      this.initialized = true
      if (this.mode === 'exit') return this.crash(17)
      return this.send({
        id: message.id,
        result: {
          userAgent: 'fake-codex/0.147.0',
          codexHome: '/private/codex-home',
          platformFamily: 'unix',
          platformOs: 'linux'
        }
      })
    }
    if (message.method === 'initialized') return
    if (!this.initialized) {
      return this.send({ id: message.id, error: { code: -32002, message: 'Not initialized' } })
    }
    if (message.method === 'never/respond') return
    if (message.method === 'server/error') {
      return this.send({
        id: message.id,
        error: { code: 429, message: `secret:${this.options.secret ?? ''}` }
      })
    }
    if (message.method === 'slow') {
      setTimeout(() => this.send({ id: message.id, result: { value: 'slow' } }), 20)
      return
    }
    if (message.method === 'fast') {
      return this.send({ id: message.id, result: { value: 'fast' } })
    }
    if (message.method === 'emit/notification') {
      this.send({ method: 'test/notification', params: { value: 7 } })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'emit/server-request') {
      this.send({
        id: 9001,
        method: 'item/commandExecution/requestApproval',
        params: { command: ['evil'] }
      })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'account/read') {
      return this.send({
        id: message.id,
        result: {
          account:
            this.mode === 'api-key-account'
              ? { type: 'apiKey' }
              : { type: 'chatgpt', email: 'private@example.com', planType: 'plus' },
          requiresOpenaiAuth: true
        }
      })
    }
    if (message.method === 'account/login/start') {
      const loginId = 'login-1'
      this.send({
        id: message.id,
        result: {
          type: 'chatgpt',
          loginId,
          authUrl:
            this.options.authUrl ?? 'https://auth.openai.com/oauth/authorize?private=yes'
        }
      })
      setTimeout(
        () =>
          this.send({
            method: 'account/login/completed',
            params: {
              loginId,
              success: this.mode !== 'login-failed',
              error: this.mode === 'login-failed' ? 'private upstream login detail' : null,
              onboardingEntrypoint: null
            }
          }),
        5
      )
      return
    }
    if (message.method === 'account/login/cancel') {
      return this.send({ id: message.id, result: { status: 'canceled' } })
    }
    if (message.method === 'account/logout') return this.send({ id: message.id, result: {} })
    if (message.method === 'model/list') return this.listModels(message)
    if (message.method === 'thread/start') {
      this.threadCounter += 1
      const thread: Record<string, any> = {
        id: `thread-${this.threadCounter}`,
        sessionId: `thread-${this.threadCounter}`,
        forkedFromId: null,
        parentThreadId: null,
        preview: '',
        ephemeral: true,
        section: null,
        sectionEnteredAt: null,
        modelProvider: 'openai',
        createdAt: 1,
        updatedAt: 1,
        recencyAt: null,
        status: { type: 'idle' },
        path: null,
        cwd: message.params.cwd,
        cliVersion: '0.147.0',
        source: { custom: 'ai_debates' },
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: []
      }
      if (this.mode === 'malformed-thread') thread.unknown = true
      return this.send({
        id: message.id,
        result: {
          thread,
          model: message.params.model,
          modelProvider: 'openai',
          serviceTier: null,
          cwd: message.params.cwd,
          instructionSources: [],
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'readOnly', networkAccess: false },
          reasoningEffort: null
        }
      })
    }
    if (message.method === 'turn/start') return this.startTurn(message)
    if (message.method === 'turn/interrupt') return this.send({ id: message.id, result: {} })
    if (message.id !== undefined && message.method !== undefined) {
      this.send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  private listModels(message: Record<string, any>): void {
    const second = message.params?.cursor === 'page-2'
    const makeModel = (id: string, isDefault = false): Record<string, any> => ({
      id,
      model: id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: id.toUpperCase(),
      description: 'fake',
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'fast' },
        { reasoningEffort: 'high', description: 'careful' }
      ],
      defaultReasoningEffort: 'low',
      inputModalities: ['text'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault
    })
    const data = second ? [makeModel('gpt-second')] : [makeModel('gpt-test', true)]
    if (this.mode === 'duplicate-models' && second) data[0] = makeModel('gpt-test')
    if (this.mode === 'malformed-catalog') data[0].unknown = true
    this.send({ id: message.id, result: { data, nextCursor: second ? null : 'page-2' } })
  }

  private startTurn(message: Record<string, any>): void {
    this.turnCounter += 1
    const turnId = `turn-${this.turnCounter}`
    this.send({
      id: message.id,
      result: {
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null
        }
      }
    })
    queueMicrotask(() => {
      this.send({
        method: 'item/reasoning/textDelta',
        params: { threadId: message.params.threadId, turnId, delta: 'SECRET_REASONING' }
      })
      this.send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'wrong-thread', turnId, itemId: 'wrong', delta: 'WRONG' }
      })
      if (this.mode === 'malformed-delta') {
        this.send({
          method: 'item/agentMessage/delta',
          params: { threadId: message.params.threadId, turnId, itemId: 'msg', delta: 7 }
        })
      } else if (this.mode === 'oversized-delta') {
        this.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: message.params.threadId,
            turnId,
            itemId: 'msg',
            delta: 'x'.repeat(200_001)
          }
        })
      } else if (this.mode !== 'empty-turn') {
        this.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: message.params.threadId,
            turnId,
            itemId: 'msg',
            delta: '{"speech":"回应",'
          }
        })
      }
      if (this.mode === 'crash-active') return this.crash(19)
      setTimeout(() => this.completeTurn(message, turnId), 25)
    })
  }

  private completeTurn(message: Record<string, any>, turnId: string): void {
    if (!['empty-turn', 'malformed-delta', 'oversized-delta'].includes(this.mode)) {
      this.send({
        method: 'item/agentMessage/delta',
        params: {
          threadId: message.params.threadId,
          turnId,
          itemId: 'msg',
          delta: '"status":"continue"}'
        }
      })
    }
    const status =
      this.mode === 'turn-failed'
        ? 'failed'
        : this.mode === 'turn-interrupted'
          ? 'interrupted'
          : 'completed'
    if (this.mode === 'out-of-order') {
      this.send({
        method: 'turn/completed',
        params: {
          threadId: message.params.threadId,
          turn: {
            id: 'wrong-turn',
            items: [],
            itemsView: 'full',
            status: 'completed',
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1
          }
        }
      })
    }
    const completion = {
      method: 'turn/completed',
      params: {
        threadId: message.params.threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status,
          error:
            status === 'failed'
              ? { message: 'private error', codexErrorInfo: null, additionalDetails: null }
              : null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1
        }
      }
    }
    this.send(completion)
    if (this.mode === 'duplicate-completion') this.send(completion)
  }
}
