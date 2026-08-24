import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import {
  normalizeCredentialKey,
  redactForLogging,
  redactString
} from '../providers/http/redaction'

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_CONTEXT_DEPTH = 20
const MAX_CONTEXT_NODES = 5_000
const queues = new Map<string, Promise<void>>()

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])
const logRecordSchema = z.strictObject({
  timestamp: z.string().datetime({ offset: true }),
  level: logLevelSchema,
  message: z.string().max(16_384),
  context: z.unknown().optional()
})

export type LogLevel = z.output<typeof logLevelSchema>

export interface LogServiceOptions {
  clock?: () => Date
  maxEntryBytes?: number
  maxFileBytes?: number
}

interface SnapshotState {
  ancestors: WeakSet<object>
  nodes: number
}

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 128) {
    throw new RangeError(`${label} must be a safe integer of at least 128`)
  }
  return value
}

const isForbiddenLogKey = (key: string): boolean => {
  const normalized = normalizeCredentialKey(key)
  return (
    normalized.includes('reasoning') ||
    normalized.includes('chainofthought') ||
    normalized.includes('rawpayload') ||
    normalized.includes('rawproviderpayload')
  )
}

const safeSnapshot = (
  value: unknown,
  state: SnapshotState,
  depth = 0
): unknown => {
  state.nodes += 1
  if (state.nodes > MAX_CONTEXT_NODES || depth > MAX_CONTEXT_DEPTH) return '[OMITTED: limit]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[OMITTED: non-finite]'
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return `[OMITTED: ${typeof value}]`
  }
  if (typeof value !== 'object') return '[OMITTED]'
  if (state.ancestors.has(value)) return '[Circular]'
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      return Array.from({ length: Math.min(value.length, 1_000) }, (_, index) => {
        const descriptor = descriptors[String(index)]
        return descriptor && 'value' in descriptor
          ? safeSnapshot(descriptor.value, state, depth + 1)
          : '[OMITTED: accessor or hole]'
      })
    }

    const result: Record<string, unknown> = Object.create(null)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (value instanceof Error) {
      result.name = 'Error'
      for (const key of ['message', 'stack', 'cause']) {
        const descriptor = descriptors[key]
        if (descriptor && 'value' in descriptor) {
          result[key] = safeSnapshot(descriptor.value, state, depth + 1)
        }
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || isForbiddenLogKey(key)) continue
      result[key] =
        'value' in descriptor
          ? safeSnapshot(descriptor.value, state, depth + 1)
          : '[OMITTED: accessor]'
    }
    return result
  } finally {
    state.ancestors.delete(value)
  }
}

const sanitized = (value: unknown): unknown =>
  redactForLogging(safeSnapshot(value, { ancestors: new WeakSet(), nodes: 0 }), {
    maxStringLength: 4_096
  })

const errorCode = (error: unknown): unknown =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined

export class LogService {
  private readonly root: string
  private readonly clock: () => Date
  private readonly maxEntryBytes: number
  private readonly maxFileBytes: number

  constructor(root: string, options: LogServiceOptions = {}) {
    if (!isAbsolute(root)) throw new TypeError('Log root must be absolute')
    this.root = resolve(root)
    this.clock = options.clock ?? (() => new Date())
    this.maxEntryBytes = positiveSafeInteger(
      options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
      'maxEntryBytes'
    )
    this.maxFileBytes = positiveSafeInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      'maxFileBytes'
    )
    if (this.maxEntryBytes > this.maxFileBytes) {
      throw new RangeError('maxEntryBytes must not exceed maxFileBytes')
    }
  }

  info(message: string, context?: unknown): Promise<void> {
    return this.log('info', message, context)
  }

  warn(message: string, context?: unknown): Promise<void> {
    return this.log('warn', message, context)
  }

  error(error: unknown, context?: unknown): Promise<void> {
    const safeError = sanitized(error)
    const message = typeof safeError === 'string' ? safeError : JSON.stringify(safeError)
    return this.log('error', message, context)
  }

  async log(level: LogLevel, message: string, context?: unknown): Promise<void> {
    const now = this.clock()
    if (Number.isNaN(now.getTime())) throw new TypeError('Log clock returned an invalid date')
    const timestamp = now.toISOString()
    const record: Record<string, unknown> = {
      timestamp,
      level,
      message: redactString(message, { maxLength: 16_384 })
    }
    if (context !== undefined) record.context = sanitized(context)
    const validated = logRecordSchema.parse(record)
    const file = await this.resolveLogFile(`app-${timestamp.slice(0, 10)}.log`)

    let bytes = Buffer.from(`${JSON.stringify(validated)}\n`, 'utf8')
    if (bytes.byteLength > this.maxEntryBytes) {
      const fallback = logRecordSchema.parse({
        timestamp,
        level,
        message: redactString(message, { maxLength: Math.max(1, this.maxEntryBytes - 128) }),
        context: '[OMITTED: entry too large]'
      })
      bytes = Buffer.from(
        `${JSON.stringify(fallback)}\n`,
        'utf8'
      )
    }
    if (bytes.byteLength > this.maxEntryBytes) return

    await this.serialized(file, async () => {
      let handle
      try {
        try {
          const info = await lstat(file)
          if (!info.isFile() || info.isSymbolicLink()) {
            throw new TypeError('Log target must be a regular non-symlink file')
          }
          if (info.size + bytes.byteLength > this.maxFileBytes) return
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error
        }
        handle = await open(
          file,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            (constants.O_NOFOLLOW ?? 0),
          0o600
        )
        const info = await handle.stat()
        if (!info.isFile()) throw new TypeError('Log target must be a regular file')
        if (info.size + bytes.byteLength > this.maxFileBytes) return
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle?.close().catch(() => undefined)
      }
    })
  }

  private async resolveLogFile(fileName: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await realpath(this.root)) !== this.root) {
      throw new TypeError('Log root must be a canonical non-symlink directory')
    }
    const logs = join(this.root, 'logs')
    await mkdir(logs, { mode: 0o700 }).catch((error) => {
      if (errorCode(error) !== 'EEXIST') throw error
    })
    const logsInfo = await lstat(logs)
    if (!logsInfo.isDirectory() || logsInfo.isSymbolicLink()) {
      throw new TypeError('Logs path must be a non-symlink directory')
    }
    return join(logs, fileName)
  }

  private async serialized(file: string, operation: () => Promise<void>): Promise<void> {
    const previous = queues.get(file) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    queues.set(file, tail)
    try {
      await run
    } finally {
      if (queues.get(file) === tail) queues.delete(file)
    }
  }
}
