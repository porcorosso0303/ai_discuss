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
  | 'pre-response-event-flood'
  | 'queued-empty-delta-flood'
  | 'unrelated-thread-flood'
  | 'pre-response-byte-flood'
  | 'malformed-old-delta'
  | 'malformed-old-completion'
  | 'delayed-thread-start'
  | 'delayed-turn-start'
  | 'timeout-account'
  | 'commentary-then-final'
  | 'commentary-delta-before-start'
  | 'null-start-commentary-completed'
  | 'final-delta-before-start'
  | 'final-authoritative-mismatch'
  | 'legacy-null-phase'
  | 'hostile-item'
  | 'hostile-completion-item'
  | 'unknown-completion-item'
  | 'malformed-item'
  | 'malformed-usage'
  | 'old-malformed-usage'
  | 'usage-updates'
  | 'turn-server-overloaded'
  | 'turn-rate-limited'
  | 'turn-unauthorized'
  | 'rpc-overloaded-account'
  | 'login-no-completion'
  | 'login-first-completes'
  | 'login-late-completion'

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
  readonly rawTranscript: string[] = []
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private readonly mode: FakeCodexMode
  private initialized = false
  private threadCounter = 0
  private turnCounter = 0
  private loginCounter = 0
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
      if (line !== '') {
        this.rawTranscript.push(line)
        this.handle(JSON.parse(line) as Record<string, any>)
      }
      newline = this.inputBuffer.indexOf('\n')
    }
  }

  private send(value: unknown): void {
    if (!this.stdout.destroyed && !this.stdout.writableEnded) {
      this.stdout.write(`${JSON.stringify(value)}\n`)
    }
  }

  private sendRaw(value: string): void {
    if (!this.stdout.destroyed && !this.stdout.writableEnded) {
      this.stdout.write(`${value}\n`)
    }
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
    if (message.method === 'emit/server-request-string') {
      this.send({
        id: 'approval-request-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: ['evil'] },
        trace: { traceparent: '00-abc-def-01', tracestate: null }
      })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'emit/server-request-int64') {
      this.send({
        id: 9_223_372_036_854_775_000,
        method: 'tool/requestUserInput',
        params: { questions: ['steal credentials'] },
        trace: null
      })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'emit/server-request-invalid-id') {
      this.send({ id: message.params.id, method: 'hostile/request', params: {} })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'emit/server-request-invalid-trace') {
      this.send({
        id: 'invalid-trace',
        method: 'hostile/request',
        params: {},
        trace: { traceparent: 7 }
      })
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'emit/server-request-raw') {
      const requests: Record<string, string> = {
        max: '{"method":"hostile/request","id":9223372036854775807,"params":{}}',
        min: '{"id":-9223372036854775808,"params":{},"method":"hostile/request"}',
        maxPlusOne: '{"id":9223372036854775808,"method":"hostile/request"}',
        minMinusOne: '{"method":"hostile/request","id":-9223372036854775809}',
        exponent: '{"method":"hostile/request","id":1e3}',
        duplicateId: '{"id":1,"method":"hostile/request","id":2}',
        duplicateEscapedId:
          '{"id":1,"method":"hostile/request","\\u0069d":2}',
        trickyString:
          '{ "params": {"id": 999, "text": "escaped \\\"id\\\""}, "trace": null, "method": "hostile/request", "id": "escaped\\\"id\\\\tail\\u0061" }'
      }
      this.sendRaw(requests[message.params.case])
      return this.send({ id: message.id, result: {} })
    }
    if (message.method === 'account/read') {
      if (this.mode === 'timeout-account') return
      if (this.mode === 'rpc-overloaded-account') {
        return this.send({
          id: message.id,
          error: { code: -32001, message: 'private overload detail' }
        })
      }
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
      this.loginCounter += 1
      const loginId = `login-${this.loginCounter}`
      this.send({
        id: message.id,
        result: {
          type: 'chatgpt',
          loginId,
          authUrl:
            this.options.authUrl ?? 'https://auth.openai.com/oauth/authorize?private=yes'
        }
      })
      if (
        this.mode !== 'login-no-completion' &&
        this.mode !== 'login-late-completion' &&
        !(this.mode === 'login-first-completes' && this.loginCounter > 1)
      ) {
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
      }
      return
    }
    if (message.method === 'account/login/cancel') {
      const currentLoginId = `login-${this.loginCounter}`
      const status = message.params.loginId === currentLoginId ? 'canceled' : 'notFound'
      this.send({ id: message.id, result: { status } })
      if (this.mode === 'login-late-completion' && status === 'canceled') {
        setTimeout(
          () =>
            this.send({
              method: 'account/login/completed',
              params: {
                loginId: message.params.loginId,
                success: false,
                error: 'late canceled login',
                onboardingEntrypoint: null
              }
            }),
          5
        )
      }
      return
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
      const response = {
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
      }
      if (this.mode === 'delayed-thread-start') {
        setTimeout(() => this.send(response), 25)
        return
      }
      return this.send(response)
    }
    if (message.method === 'turn/start') {
      if (this.mode === 'delayed-turn-start') {
        setTimeout(() => this.startTurn(message), 25)
        return
      }
      return this.startTurn(message)
    }
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
    if (
      this.mode === 'pre-response-event-flood' ||
      this.mode === 'unrelated-thread-flood'
    ) {
      const threadId =
        this.mode === 'unrelated-thread-flood' ? 'unrelated-thread' : message.params.threadId
      for (let index = 0; index < 4_200; index += 1) {
        this.send({
          method: 'item/agentMessage/delta',
          params: { threadId, turnId, itemId: `flood-${index}`, delta: '' }
        })
      }
    }
    if (this.mode === 'pre-response-byte-flood') {
      for (let index = 0; index < 2; index += 1) {
        this.send({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: {
              id: `old-large-turn-${index}`,
              items: [{ type: 'agentMessage', id: `old-${index}`, text: 'x'.repeat(600_000) }],
              status: 'completed'
            }
          }
        })
      }
    }
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
      if (this.mode === 'hostile-item') {
        this.send({
          method: 'item/started',
          params: {
            threadId: message.params.threadId,
            turnId,
            startedAtMs: 1,
            item: { type: 'commandExecution', id: 'hostile-command' }
          }
        })
      } else if (this.mode === 'malformed-item') {
        this.send({
          method: 'item/started',
          params: {
            threadId: message.params.threadId,
            turnId,
            startedAtMs: 1,
            item: { type: 'agentMessage', id: 'msg', text: '', phase: 7 }
          }
        })
      } else {
        if (
          this.mode === 'commentary-then-final' ||
          this.mode === 'commentary-delta-before-start' ||
          this.mode === 'null-start-commentary-completed'
        ) {
          if (this.mode === 'commentary-delta-before-start') {
            this.send({
              method: 'item/agentMessage/delta',
              params: {
                threadId: message.params.threadId,
                turnId,
                itemId: 'commentary',
                delta: 'PRIVATE_COMMENTARY'
              }
            })
          }
          this.send({
            method: 'item/started',
            params: {
              threadId: message.params.threadId,
              turnId,
              startedAtMs: 1,
              item: {
                type: 'agentMessage',
                id: 'commentary',
                text: '',
                phase: this.mode === 'null-start-commentary-completed' ? null : 'commentary',
                memoryCitation: null
              }
            }
          })
          if (this.mode !== 'commentary-delta-before-start') {
            this.send({
              method: 'item/agentMessage/delta',
              params: {
                threadId: message.params.threadId,
                turnId,
                itemId: 'commentary',
                delta: 'PRIVATE_COMMENTARY'
              }
            })
          }
          this.send({
            method: 'item/completed',
            params: {
              threadId: message.params.threadId,
              turnId,
              completedAtMs: 2,
              item: {
                type: 'agentMessage',
                id: 'commentary',
                text: 'PRIVATE_COMMENTARY',
                phase: 'commentary',
                memoryCitation: null
              }
            }
          })
        }
        if (this.mode === 'final-delta-before-start') {
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
        this.send({
          method: 'item/started',
          params: {
            threadId: message.params.threadId,
            turnId,
            startedAtMs: 1,
            item: {
              type: 'agentMessage',
              id: 'msg',
              text: '',
              phase: this.mode === 'legacy-null-phase' ? null : 'final_answer',
              memoryCitation: null
            }
          }
        })
      }
      if (this.mode === 'malformed-old-delta') {
        this.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: message.params.threadId,
            turnId: 'old-turn',
            itemId: 'old-message',
            delta: 7
          }
        })
      }
      if (this.mode === 'malformed-old-completion') {
        this.send({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: { id: 'old-turn', items: 'malformed', status: 'completed' }
          }
        })
      }
      if (this.mode === 'queued-empty-delta-flood') {
        for (let index = 0; index < 4_200; index += 1) {
          this.send({
            method: 'item/agentMessage/delta',
            params: {
              threadId: message.params.threadId,
              turnId,
              itemId: `empty-${index}`,
              delta: ''
            }
          })
        }
      }
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
      } else if (this.mode === 'final-authoritative-mismatch') {
        this.send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: message.params.threadId,
            turnId,
            itemId: 'msg',
            delta: 'PRIVATE_COMMENTARY_NOT_JSON'
          }
        })
      } else if (this.mode !== 'empty-turn' && this.mode !== 'final-delta-before-start') {
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
    if (
      ![
        'empty-turn',
        'malformed-delta',
        'oversized-delta',
        'final-authoritative-mismatch'
      ].includes(this.mode)
    ) {
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
    this.send({
      method: 'item/completed',
      params: {
        threadId: message.params.threadId,
        turnId,
        completedAtMs: 2,
        item: {
          type: 'agentMessage',
          id: 'msg',
          text:
            this.mode === 'empty-turn'
              ? ''
              : '{"speech":"回应","status":"continue"}',
          phase: this.mode === 'legacy-null-phase' ? null : 'final_answer',
          memoryCitation: null
        }
      }
    })
    this.send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'wrong-thread',
        turnId,
        tokenUsage: { last: 'malformed', total: {} }
      }
    })
    if (this.mode === 'old-malformed-usage') {
      this.send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: message.params.threadId,
          turnId: 'old-turn',
          tokenUsage: { last: 'malformed', total: {} }
        }
      })
    }
    if (this.mode === 'usage-updates') {
      this.sendTokenUsage(message.params.threadId, turnId, {
        totalTokens: 9,
        inputTokens: 4,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 1
      })
    }
    if (this.mode === 'malformed-usage') {
      this.send({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: message.params.threadId,
          turnId,
          tokenUsage: { last: { outputTokens: 'private' }, total: {} }
        }
      })
    } else {
      this.sendTokenUsage(message.params.threadId, turnId, {
        totalTokens: 18,
        inputTokens: 11,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 2
      })
    }
    const status =
      this.mode === 'turn-failed' ||
      this.mode === 'turn-server-overloaded' ||
      this.mode === 'turn-rate-limited' ||
      this.mode === 'turn-unauthorized'
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
          items:
            this.mode === 'hostile-completion-item'
              ? [{ type: 'fileChange', id: 'hostile-file' }]
              : this.mode === 'unknown-completion-item'
                ? [{ type: 'futureTool', id: 'unknown-tool' }]
              : [],
          itemsView: 'full',
          status,
          error:
            status === 'failed'
              ? {
                  message: 'private error',
                  codexErrorInfo:
                    this.mode === 'turn-server-overloaded'
                      ? 'serverOverloaded'
                      : this.mode === 'turn-rate-limited'
                        ? { responseStreamConnectionFailed: { httpStatusCode: 429 } }
                        : this.mode === 'turn-unauthorized'
                          ? 'unauthorized'
                          : null,
                  additionalDetails: null
                }
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

  private sendTokenUsage(
    threadId: string,
    turnId: string,
    last: Record<string, number>
  ): void {
    this.send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId,
        turnId,
        tokenUsage: { total: last, last, modelContextWindow: 200_000 }
      }
    })
  }
}
