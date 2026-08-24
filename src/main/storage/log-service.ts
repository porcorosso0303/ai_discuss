import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import {
  normalizeCredentialKey,
  redactForLogging,
  redactString
} from '../providers/http/redaction'
import {
  DirectoryIdentityGuard,
  initializeGuardedDirectory,
  type FilesystemMutationHook
} from './directory-identity'
import { runKeyedTransaction } from './transaction-coordinator'

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_CONTEXT_DEPTH = 20
const MAX_CONTEXT_NODES = 5_000

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
  filesystemHook?: FilesystemMutationHook
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
  private readonly filesystemHook?: FilesystemMutationHook

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
    this.filesystemHook = options.filesystemHook
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
    const fileName = `app-${timestamp.slice(0, 10)}.log`
    const file = join(this.root, 'logs', fileName)

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
      const resolvedFile = await this.resolveLogFile(fileName)
      if (resolvedFile !== file) throw new TypeError('Resolved log path changed unexpectedly')
      const guard = await DirectoryIdentityGuard.capture(join(this.root, 'logs'), {
        anchor: this.root,
        hook: this.filesystemHook
      })
      let handle
      try {
        let pathInfo
        try {
          await guard.before('before-file-cap-check', file)
          pathInfo = await lstat(file)
          await guard.after()
          if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
            throw new TypeError('Log target must be a regular non-symlink file')
          }
          if (pathInfo.size + bytes.byteLength > this.maxFileBytes) return
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error
        }
        await guard.before('before-target-open', file)
        handle = await open(
          file,
          constants.O_WRONLY |
            constants.O_APPEND |
            constants.O_CREAT |
            (constants.O_NOFOLLOW ?? 0),
          0o600
        )
        await guard.after()
        const info = await handle.stat()
        if (!info.isFile()) throw new TypeError('Log target must be a regular file')
        if (pathInfo !== undefined) {
          if (info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
            throw new TypeError('Log target identity changed before it was opened')
          }
        } else {
          const createdInfo = await lstat(file)
          if (
            !createdInfo.isFile() ||
            createdInfo.isSymbolicLink() ||
            info.dev !== createdInfo.dev ||
            info.ino !== createdInfo.ino
          ) {
            throw new TypeError('Created log target identity does not match its open handle')
          }
        }
        if (info.size + bytes.byteLength > this.maxFileBytes) return
        await guard.before('before-file-write', file)
        await handle.writeFile(bytes)
        await guard.after()
        await handle.sync()
      } finally {
        if (handle !== undefined) {
          const closingHandle = handle
          handle = undefined
          let closeError: unknown
          try {
            await closingHandle.close()
          } catch (error) {
            closeError = error
          }
          await guard.before('after-target-close', file)
          if (closeError !== undefined) throw closeError
        }
      }
    })
  }

  private async resolveLogFile(fileName: string): Promise<string> {
    await initializeGuardedDirectory(this.root, { hook: this.filesystemHook })
    const logs = join(this.root, 'logs')
    await initializeGuardedDirectory(logs, { hook: this.filesystemHook })
    return join(logs, fileName)
  }

  private async serialized(file: string, operation: () => Promise<void>): Promise<void> {
    await runKeyedTransaction(file, 'log-file', operation)
  }
}
