import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import type { z } from 'zod'

import { REDACTED } from '../http/redaction'
import { initializeResponseSchema } from './codex-events'

export interface CodexClientInfo {
  name: string
  title: string | null
  version: string
}

export interface CodexJsonRpcClientOptions {
  maxLineBytes?: number
  maxStderrBytes?: number
  maxPending?: number
  requestTimeoutMs?: number
}

export interface CodexProcessTransport extends EventEmitter {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(): boolean
}

interface PendingRequest {
  method: string
  schema: z.ZodType
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type NotificationHandler = (params: unknown) => void

export class JsonRpcProtocolError extends Error {}

export class JsonRpcTransportError extends Error {}

export class JsonRpcServerError extends Error {
  constructor(
    readonly code: number,
    readonly method: string
  ) {
    super(`Codex App Server rejected ${method} (code ${code})`)
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key))

const isJsonRpcRequestId = (value: unknown): value is string | number =>
  typeof value === 'string' ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= -9_223_372_036_854_776_000 &&
    value <= 9_223_372_036_854_776_000)

const isW3cTraceContext = (value: unknown): boolean => {
  if (value === null) return true
  if (!isObject(value)) return false
  for (const key of ['traceparent', 'tracestate'] as const) {
    if (
      Object.hasOwn(value, key) &&
      value[key] !== null &&
      typeof value[key] !== 'string'
    ) {
      return false
    }
  }
  return true
}

const safePositiveInteger = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError('Limit must be positive')
  return result
}

export class CodexJsonRpcClient {
  private readonly maxLineBytes: number
  private readonly maxStderrBytes: number
  private readonly maxPending: number
  private readonly requestTimeoutMs: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private readonly failureHandlers = new Set<(error: Error) => void>()
  private readonly decoder = new StringDecoder('utf8')
  private nextId = 1
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private state: 'new' | 'initializing' | 'ready' | 'failed' | 'disposed' = 'new'
  private failure: Error | undefined

  constructor(
    private readonly child: CodexProcessTransport,
    options: CodexJsonRpcClientOptions = {}
  ) {
    this.maxLineBytes = safePositiveInteger(options.maxLineBytes, 1024 * 1024)
    this.maxStderrBytes = safePositiveInteger(options.maxStderrBytes, 4_096)
    this.maxPending = safePositiveInteger(options.maxPending, 64)
    this.requestTimeoutMs = safePositiveInteger(options.requestTimeoutMs, 30_000)

    child.stdout.on('data', this.handleStdout)
    child.stderr.on('data', this.handleStderr)
    child.stdin.on('error', this.handleProcessError)
    child.stdout.on('error', this.handleProcessError)
    child.stderr.on('error', this.handleProcessError)
    child.once('error', this.handleProcessError)
    child.once('exit', this.handleExit)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get diagnostics(): { stderr: string } {
    return { stderr: this.stderrBuffer }
  }

  async initialize(clientInfo: CodexClientInfo): Promise<void> {
    if (this.state !== 'new') {
      throw new JsonRpcProtocolError('Codex App Server must be initialized exactly once')
    }
    this.state = 'initializing'
    try {
      await this.sendRequest(
        'initialize',
        { clientInfo, capabilities: null },
        initializeResponseSchema
      )
      this.writeMessage({ method: 'initialized' })
      this.state = 'ready'
    } catch (error) {
      this.fail(error instanceof Error ? error : new JsonRpcProtocolError('Initialization failed'))
      throw this.failure
    }
  }

  async request<Schema extends z.ZodType>(
    method: string,
    params: unknown,
    schema: Schema
  ): Promise<z.output<Schema>> {
    if (this.state !== 'ready') {
      throw this.failure ?? new JsonRpcProtocolError('Codex App Server is not initialized')
    }
    return (await this.sendRequest(method, params, schema)) as z.output<Schema>
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== 'ready') throw new JsonRpcProtocolError('Codex App Server is not initialized')
    this.writeMessage(params === undefined ? { method } : { method, params })
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method)
    if (handlers === undefined) {
      handlers = new Set()
      this.notificationHandlers.set(method, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers?.delete(handler)
      if (handlers?.size === 0) this.notificationHandlers.delete(method)
    }
  }

  onFailure(handler: (error: Error) => void): () => void {
    this.failureHandlers.add(handler)
    if (this.failure !== undefined) {
      queueMicrotask(() => {
        try {
          handler(this.failure as Error)
        } catch {
          // A consumer cannot corrupt transport cleanup.
        }
      })
    }
    return () => this.failureHandlers.delete(handler)
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return
    this.state = 'disposed'
    this.rejectPending(new JsonRpcTransportError('Codex App Server connection closed'))
    this.notificationHandlers.clear()
    this.failureHandlers.clear()
    this.child.stdout.off('data', this.handleStdout)
    this.child.stderr.off('data', this.handleStderr)
    this.child.stdin.off('error', this.handleProcessError)
    this.child.stdout.off('error', this.handleProcessError)
    this.child.stderr.off('error', this.handleProcessError)
    this.child.off('error', this.handleProcessError)
    this.child.off('exit', this.handleExit)
    this.child.stdin.end()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }

  private sendRequest(method: string, params: unknown, schema: z.ZodType): Promise<unknown> {
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new JsonRpcProtocolError('Too many pending Codex requests'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new JsonRpcTransportError(`Codex request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { method, schema, resolve, reject, timer })
      try {
        this.writeMessage({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new JsonRpcTransportError('Codex write failed'))
      }
    })
  }

  private writeMessage(message: unknown): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new JsonRpcTransportError('Codex App Server stdin is unavailable')
    }
    const encoded = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(encoded) > this.maxLineBytes) {
      throw new JsonRpcProtocolError('Outbound Codex message exceeds the line limit')
    }
    this.child.stdin.write(encoded)
  }

  private readonly handleStdout = (chunk: Buffer): void => {
    if (this.state === 'failed' || this.state === 'disposed') return
    this.stdoutBuffer += this.decoder.write(chunk)
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxLineBytes && !this.stdoutBuffer.includes('\n')) {
      this.fail(new JsonRpcProtocolError('Codex stdout line exceeds the configured limit'))
      return
    }
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.fail(new JsonRpcProtocolError('Codex stdout line exceeds the configured limit'))
        return
      }
      if (line !== '') {
        try {
          this.handleLine(line)
        } catch (error) {
          this.fail(
            error instanceof JsonRpcProtocolError
              ? error
              : new JsonRpcProtocolError('Codex emitted an invalid protocol message')
          )
          return
        }
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  private readonly handleStderr = (chunk: Buffer): void => {
    if (chunk.length > 0) this.stderrBuffer = REDACTED.slice(0, this.maxStderrBytes)
  }

  private handleLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new JsonRpcProtocolError('Codex emitted malformed JSON')
    }
    if (!isObject(value)) throw new JsonRpcProtocolError('Codex emitted a non-object message')

    const hasId = Object.hasOwn(value, 'id')
    const hasMethod = typeof value.method === 'string'
    if (hasId && hasMethod) {
      if (
        !hasOnlyKeys(value, ['id', 'method', 'params', 'trace']) ||
        !isJsonRpcRequestId(value.id) ||
        (Object.hasOwn(value, 'trace') && !isW3cTraceContext(value.trace))
      ) {
        throw new JsonRpcProtocolError('Invalid server request envelope')
      }
      this.writeMessage({
        id: value.id,
        error: { code: -32601, message: 'Method not found' }
      })
      return
    }
    if (hasMethod) {
      if (!hasOnlyKeys(value, ['method', 'params'])) {
        throw new JsonRpcProtocolError('Invalid notification envelope')
      }
      for (const handler of this.notificationHandlers.get(value.method as string) ?? []) {
        try {
          handler(value.params)
        } catch {
          // A consumer cannot corrupt the shared transport.
        }
      }
      return
    }
    if (hasId) {
      if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) {
        throw new JsonRpcProtocolError('Invalid response id')
      }
      const pending = this.pending.get(value.id)
      if (pending === undefined) throw new JsonRpcProtocolError('Unknown or duplicate response id')
      this.pending.delete(value.id)
      clearTimeout(pending.timer)

      if (Object.hasOwn(value, 'error')) {
        if (!hasOnlyKeys(value, ['id', 'error']) || !isObject(value.error)) {
          pending.reject(new JsonRpcProtocolError('Invalid error response'))
          return
        }
        const error = value.error
        if (
          typeof error.code !== 'number' ||
          !Number.isSafeInteger(error.code) ||
          typeof error.message !== 'string' ||
          !hasOnlyKeys(error, ['code', 'message', 'data'])
        ) {
          pending.reject(new JsonRpcProtocolError('Invalid server error'))
          return
        }
        pending.reject(new JsonRpcServerError(error.code, pending.method))
        return
      }
      if (!Object.hasOwn(value, 'result') || !hasOnlyKeys(value, ['id', 'result'])) {
        pending.reject(new JsonRpcProtocolError('Invalid success response'))
        return
      }
      const parsed = pending.schema.safeParse(value.result)
      if (!parsed.success) {
        pending.reject(new JsonRpcProtocolError(`Invalid Codex response for ${pending.method}`))
        return
      }
      pending.resolve(parsed.data)
      return
    }
    throw new JsonRpcProtocolError('Unknown Codex protocol message')
  }

  private readonly handleProcessError = (): void => {
    this.fail(new JsonRpcTransportError('Codex App Server process failed'))
  }

  private readonly handleExit = (): void => {
    if (this.state !== 'disposed') {
      this.fail(new JsonRpcTransportError('Codex App Server exited unexpectedly'))
    }
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'disposed') return
    this.state = 'failed'
    this.failure = error
    this.rejectPending(error)
    this.notificationHandlers.clear()
    for (const handler of this.failureHandlers) {
      try {
        handler(error)
      } catch {
        // A consumer cannot corrupt transport cleanup.
      }
    }
    this.failureHandlers.clear()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
