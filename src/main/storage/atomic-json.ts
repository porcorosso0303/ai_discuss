import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { types as utilTypes } from 'node:util'

import type { ZodType } from 'zod'

import { isSensitiveCredentialKey } from '../providers/http/redaction'
import {
  DirectoryIdentityGuard,
  initializeGuardedDirectory,
  type FilesystemMutationHook
} from './directory-identity'
import { runKeyedTransaction } from './transaction-coordinator'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_DEPTH = 40
const DEFAULT_MAX_NODES = 100_000

export interface AtomicJsonStoreOptions {
  maxBytes?: number
  maxDepth?: number
  maxNodes?: number
  filesystemHook?: FilesystemMutationHook
}

interface MaterializeState {
  readonly ancestors: WeakSet<object>
  nodes: number
}

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

const materializeJson = (
  value: unknown,
  state: MaterializeState,
  depth: number,
  maxDepth: number,
  maxNodes: number
): unknown => {
  state.nodes += 1
  if (state.nodes > maxNodes) throw new RangeError('JSON value has too many nodes')
  if (depth > maxDepth) throw new RangeError('JSON value is too deeply nested')

  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite')
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Unsupported JSON value: ${typeof value}`)
  }

  if (utilTypes.isProxy(value)) throw new TypeError('Proxy JSON values are not supported')

  if (state.ancestors.has(value)) throw new TypeError('Circular JSON values are not supported')
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const result: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('Sparse arrays and array accessors are not supported')
        }
        result.push(materializeJson(descriptor.value, state, depth + 1, maxDepth, maxNodes))
      }
      return result
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain JSON objects are supported')
    }

    const result: Record<string, unknown> = Object.create(null)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue
      if (!('value' in descriptor)) throw new TypeError('JSON object accessors are not supported')
      if (isSensitiveCredentialKey(key)) throw new TypeError('Sensitive field is not allowed')
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new TypeError(`Unsafe JSON key is not allowed: ${key}`)
      }
      result[key] = materializeJson(descriptor.value, state, depth + 1, maxDepth, maxNodes)
    }
    return result
  } finally {
    state.ancestors.delete(value)
  }
}

const toSafeJson = (value: unknown, maxDepth: number, maxNodes: number): unknown =>
  materializeJson(value, { ancestors: new WeakSet(), nodes: 0 }, 0, maxDepth, maxNodes)

export const parseSafeJson = <T>(
  schema: ZodType<T>,
  value: unknown,
  options: Pick<AtomicJsonStoreOptions, 'maxDepth' | 'maxNodes'> = {}
): T => {
  const maxDepth = positiveSafeInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 'maxDepth')
  const maxNodes = positiveSafeInteger(options.maxNodes ?? DEFAULT_MAX_NODES, 'maxNodes')
  const input = toSafeJson(value, maxDepth, maxNodes)
  const parsed = schema.parse(input)
  return toSafeJson(parsed, maxDepth, maxNodes) as T
}

const isInside = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const syncDirectoryBestEffort = async (directory: string): Promise<void> => {
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (process.platform !== 'win32' && code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') {
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export class AtomicJsonStore {
  private readonly root: string
  private readonly maxBytes: number
  private readonly maxDepth: number
  private readonly maxNodes: number
  private readonly filesystemHook?: FilesystemMutationHook

  constructor(root: string, options: AtomicJsonStoreOptions = {}) {
    if (!isAbsolute(root)) throw new TypeError('Atomic JSON root must be absolute')
    this.root = resolve(root)
    this.maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
    this.maxDepth = positiveSafeInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 'maxDepth')
    this.maxNodes = positiveSafeInteger(options.maxNodes ?? DEFAULT_MAX_NODES, 'maxNodes')
    this.filesystemHook = options.filesystemHook
  }

  async read<T>(relativePath: string, schema: ZodType<T>): Promise<T | null> {
    const target = await this.resolveTarget(relativePath, false)
    let handle
    try {
      const guard = await DirectoryIdentityGuard.capture(dirname(target), {
        anchor: this.root,
        hook: this.filesystemHook
      })
      const pathInfo = await lstat(target)
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw new TypeError('JSON target must be a regular non-symlink file')
      }
      await guard.before('before-target-open', target)
      handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      await guard.after()
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new TypeError('JSON target must be a regular file')
      if (metadata.dev !== pathInfo.dev || metadata.ino !== pathInfo.ino) {
        throw new TypeError('JSON target identity changed before it was opened')
      }
      if (metadata.size > this.maxBytes) throw new RangeError('JSON file is too large')
      const bytes = await handle.readFile()
      await guard.after()
      if (bytes.byteLength > this.maxBytes) throw new RangeError('JSON file is too large')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const decoded = JSON.parse(text) as unknown
      const safe = toSafeJson(decoded, this.maxDepth, this.maxNodes)
      return parseSafeJson(schema, safe, { maxDepth: this.maxDepth, maxNodes: this.maxNodes })
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  async write<T>(relativePath: string, schema: ZodType<T>, value: unknown): Promise<T> {
    const target = await this.resolveTarget(relativePath, true)
    return this.serialized(target, async () => {
      const guard = await DirectoryIdentityGuard.capture(dirname(target), {
        anchor: this.root,
        hook: this.filesystemHook
      })
      await this.assertTargetIsRegularOrMissing(target)
      const input = toSafeJson(value, this.maxDepth, this.maxNodes)
      const parsed = schema.parse(input)
      const safeParsed = toSafeJson(parsed, this.maxDepth, this.maxNodes)
      const validated = schema.parse(safeParsed)
      const finalValue = toSafeJson(validated, this.maxDepth, this.maxNodes) as T
      const bytes = Buffer.from(`${JSON.stringify(finalValue)}\n`, 'utf8')
      if (bytes.byteLength > this.maxBytes) throw new RangeError('JSON output is too large')

      const directory = dirname(target)
      const temporary = resolve(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
      let handle
      try {
        await guard.before('before-temp-open', temporary)
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600
        )
        await guard.after()
        await handle.writeFile(bytes)
        await handle.sync()
        await handle.close()
        handle = undefined
        await guard.before('before-rename', target)
        await rename(temporary, target)
        await guard.after()
        await guard.before('before-directory-open', directory)
        await syncDirectoryBestEffort(directory)
        await guard.after()
        return structuredClone(finalValue)
      } catch (error) {
        await handle?.close().catch(() => undefined)
        if (await guard.cleanupIfAnchored()) {
          await guard.before('before-unlink', temporary).catch(() => undefined)
          const cleaned = await unlink(temporary).then(
            () => true,
            () => false
          )
          if (cleaned) await guard.after().catch(() => undefined)
        }
        throw error
      }
    })
  }

  async delete(relativePath: string): Promise<boolean> {
    const target = await this.resolveTarget(relativePath, false)
    return this.serialized(target, async () => {
      try {
        const guard = await DirectoryIdentityGuard.capture(dirname(target), {
          anchor: this.root,
          hook: this.filesystemHook
        })
        const info = await lstat(target)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new TypeError('JSON target must be a regular non-symlink file')
        }
        await guard.before('before-unlink', target)
        await unlink(target)
        await guard.after()
        await guard.before('before-directory-open', dirname(target))
        await syncDirectoryBestEffort(dirname(target))
        await guard.after()
        return true
      } catch (error) {
        if (isMissing(error)) return false
        throw error
      }
    })
  }

  private async serialized<T>(target: string, operation: () => Promise<T>): Promise<T> {
    return await runKeyedTransaction(this.root, `atomic-target:${target}`, operation)
  }

  private async resolveTarget(relativePath: string, createParents: boolean): Promise<string> {
    return await runKeyedTransaction(this.root, 'atomic-directory-initialization', async () =>
      await this.resolveTargetUncoordinated(relativePath, createParents)
    )
  }

  private async resolveTargetUncoordinated(
    relativePath: string,
    createParents: boolean
  ): Promise<string> {
    if (
      relativePath.length === 0 ||
      relativePath.includes('\\') ||
      isAbsolute(relativePath) ||
      /^[a-zA-Z]:/.test(relativePath)
    ) {
      throw new TypeError('JSON path must be a relative portable path')
    }
    const target = resolve(this.root, relativePath)
    if (!isInside(this.root, target)) throw new TypeError('JSON path escapes its root')

    await initializeGuardedDirectory(this.root, { hook: this.filesystemHook })
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new TypeError('Atomic JSON root must be a non-symlink directory')
    }
    if ((await realpath(this.root)) !== this.root) {
      throw new TypeError('Atomic JSON root must use its canonical path')
    }

    const relativeDirectory = relative(this.root, dirname(target))
    let current = this.root
    for (const segment of relativeDirectory === '' ? [] : relativeDirectory.split(sep)) {
      current = resolve(current, segment)
      try {
        const info = await lstat(current)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new TypeError('JSON path contains a symlink or non-directory component')
        }
      } catch (error) {
        if (!isMissing(error)) throw error
        if (!createParents) return target
        const parentGuard = await DirectoryIdentityGuard.capture(dirname(current), {
          anchor: this.root,
          hook: this.filesystemHook
        })
        await parentGuard.before('before-mkdir', current)
        await mkdir(current, { mode: 0o700 }).catch(async (mkdirError) => {
          if (
            typeof mkdirError !== 'object' ||
            mkdirError === null ||
            !('code' in mkdirError) ||
            mkdirError.code !== 'EEXIST'
          ) {
            throw mkdirError
          }
        })
        await parentGuard.after()
        const info = await lstat(current)
        if (!info.isDirectory() || info.isSymbolicLink()) {
          throw new TypeError('JSON directory creation was redirected')
        }
      }
    }
    return target
  }

  private async assertTargetIsRegularOrMissing(target: string): Promise<void> {
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new TypeError('JSON target must be a regular non-symlink file')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}
