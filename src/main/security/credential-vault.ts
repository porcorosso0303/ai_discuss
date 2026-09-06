import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'

import { z } from 'zod'

import type { CredentialScope, RoleId } from '../../shared/domain'
import { credentialScopeSchema, roleIdSchema } from '../../shared/schemas'

const MAX_REQUEST_BYTES = 32 * 1024
const MAX_RESPONSE_BYTES = 8 * 1024
const MAX_SECRET_UTF16_BYTES = 2560
const MAX_ORIGIN_UTF16_UNITS = 513
const DEFAULT_TIMEOUT_MS = 10_000

const isWellFormedUTF16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

const helperErrorCodeSchema = z.enum(['invalid_request', 'unsupported', 'storage_error'])
const helperErrorResponseSchema = z.strictObject({
  ok: z.literal(false),
  errorCode: helperErrorCodeSchema
})
const helperMutationResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  helperErrorResponseSchema
])
const helperGetResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), found: z.literal(false) }),
  z.strictObject({
    ok: z.literal(true),
    found: z.literal(true),
    secret: z
      .string()
      .min(1)
      .max(MAX_SECRET_UTF16_BYTES / 2)
      .refine(isWellFormedUTF16)
  }),
  helperErrorResponseSchema
])

type ExternalProvider = CredentialScope['provider']
type VaultErrorCode =
  | 'invalid_request'
  | 'unsupported'
  | 'storage_error'
  | 'protocol_error'
  | 'process_error'
  | 'timeout'
  | 'partial_delete'
  | 'delete_failed'

export class CredentialVaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CredentialVaultError'
  }
}

export class CredentialRoleDeletionError extends CredentialVaultError {
  readonly deletedProviders: readonly ExternalProvider[]
  readonly failedProviders: readonly ExternalProvider[]

  constructor(
    deletedProviders: readonly ExternalProvider[],
    failedProviders: readonly ExternalProvider[]
  ) {
    super(
      deletedProviders.length === 0 ? 'delete_failed' : 'partial_delete',
      deletedProviders.length === 0
        ? 'Role credential deletion failed'
        : 'Role credentials were only partially deleted'
    )
    this.name = 'CredentialRoleDeletionError'
    this.deletedProviders = [...deletedProviders]
    this.failedProviders = [...failedProviders]
  }
}

export interface ResolveCredentialHelperPathOptions {
  isPackaged: boolean
  resourcesPath: string
  env?: Readonly<Record<string, string | undefined>>
}

export interface CredentialHelperProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  on(event: 'error', listener: (error: Error) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
  off(event: 'error', listener: (error: Error) => void): this
  off(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
  kill(): boolean
}

export interface CredentialHelperSpawnOptions {
  shell: false
  windowsHide: true
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
}

export type CredentialHelperSpawn = (
  command: string,
  args: readonly string[],
  options: CredentialHelperSpawnOptions
) => CredentialHelperProcess

export interface CredentialVaultOptions extends ResolveCredentialHelperPathOptions {
  hostEnv?: Readonly<NodeJS.ProcessEnv>
  spawnProcess?: CredentialHelperSpawn
  timeoutMs?: number
}

type HelperOperation = 'get' | 'set' | 'delete'

interface HelperRequest {
  operation: HelperOperation
  target: string
  origin?: string
  secret?: string
}

const isAbsoluteForHostOrWindows = (path: string): boolean =>
  isAbsolute(path) || win32.isAbsolute(path)

export const resolveCredentialHelperPath = ({
  isPackaged,
  resourcesPath,
  env = process.env
}: ResolveCredentialHelperPathOptions): string => {
  const override = !isPackaged ? env.CREDENTIAL_HELPER_BIN : undefined
  const candidate = override ?? join(resourcesPath, 'bin', 'credential-helper.exe')
  if (candidate.includes('\0') || !isAbsoluteForHostOrWindows(candidate)) {
    throw new Error('Credential helper is unavailable')
  }
  try {
    if (!statSync(candidate).isFile()) throw new Error('not a file')
  } catch {
    throw new Error('Credential helper is unavailable')
  }
  return candidate
}

const buildChildEnv = (hostEnv: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const value = hostEnv[key]
    if (value !== undefined && value.length <= 32_767 && !value.includes('\0')) result[key] = value
  }
  return result
}

const targetFor = (roleId: RoleId, provider: ExternalProvider): string =>
  `AI Debates/${roleId}/${provider}`

const safeScope = (input: CredentialScope): CredentialScope => {
  const parsed = credentialScopeSchema.safeParse(input)
  if (!parsed.success || parsed.data.origin.length > MAX_ORIGIN_UTF16_UNITS) {
    throw new CredentialVaultError('invalid_request', 'Credential request is invalid')
  }
  return parsed.data
}

const safeRoleId = (input: RoleId): RoleId => {
  const parsed = roleIdSchema.safeParse(input)
  if (!parsed.success) {
    throw new CredentialVaultError('invalid_request', 'Credential request is invalid')
  }
  return parsed.data
}

const safeSecret = (secret: string): string => {
  if (
    typeof secret !== 'string' ||
    secret.length === 0 ||
    secret.length * 2 > MAX_SECRET_UTF16_BYTES ||
    !isWellFormedUTF16(secret)
  ) {
    throw new CredentialVaultError('invalid_request', 'Credential request is invalid')
  }
  return secret
}

const abortError = (): DOMException =>
  new DOMException('Credential operation aborted', 'AbortError')

const containLateProcessError = (): void => {
  // This bounded sink lives only as long as its child or stream and never records sensitive errors.
}

const helperFailure = (code: z.output<typeof helperErrorCodeSchema>): CredentialVaultError => {
  if (code === 'unsupported') {
    return new CredentialVaultError(code, 'Credential storage is unavailable on this platform')
  }
  if (code === 'invalid_request') {
    return new CredentialVaultError(code, 'Credential request was rejected')
  }
  return new CredentialVaultError(code, 'Credential storage operation failed')
}

export class CredentialVault {
  private readonly executable: string
  private readonly childEnv: NodeJS.ProcessEnv
  private readonly spawnProcess: CredentialHelperSpawn
  private readonly timeoutMs: number

  constructor(options: CredentialVaultOptions) {
    this.executable = resolveCredentialHelperPath(options)
    this.childEnv = buildChildEnv(options.hostEnv ?? process.env)
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) => spawn(command, args, spawnOptions))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async get(scopeInput: CredentialScope, signal?: AbortSignal): Promise<string | undefined> {
    const scope = safeScope(scopeInput)
    const raw = await this.execute(
      {
        operation: 'get',
        target: targetFor(scope.roleId, scope.provider),
        origin: scope.origin
      },
      signal
    )
    const parsed = helperGetResponseSchema.safeParse(raw)
    if (!parsed.success) {
      throw new CredentialVaultError(
        'protocol_error',
        'Credential helper returned an invalid response'
      )
    }
    if (!parsed.data.ok) throw helperFailure(parsed.data.errorCode)
    return parsed.data.found ? parsed.data.secret : undefined
  }

  async set(
    scopeInput: CredentialScope,
    secretInput: string,
    signal?: AbortSignal
  ): Promise<{ stored: true }> {
    const scope = safeScope(scopeInput)
    const secret = safeSecret(secretInput)
    const raw = await this.execute(
      {
        operation: 'set',
        target: targetFor(scope.roleId, scope.provider),
        origin: scope.origin,
        secret
      },
      signal
    )
    this.requireMutationSuccess(raw)
    return { stored: true }
  }

  async delete(
    scopeInput: CredentialScope,
    signal?: AbortSignal
  ): Promise<{ deleted: true }> {
    const scope = safeScope(scopeInput)
    await this.deleteTarget(scope.roleId, scope.provider, signal)
    return { deleted: true }
  }

  async deleteRoleSecrets(
    roleIdInput: RoleId,
    signal?: AbortSignal
  ): Promise<{ deletedProviders: readonly ExternalProvider[] }> {
    const roleId = safeRoleId(roleIdInput)
    const deletedProviders: ExternalProvider[] = []
    const failedProviders: ExternalProvider[] = []
    for (const provider of ['kimi', 'deepseek'] as const) {
      try {
        await this.deleteTarget(roleId, provider, signal)
        deletedProviders.push(provider)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        failedProviders.push(provider)
      }
    }
    if (failedProviders.length > 0) {
      throw new CredentialRoleDeletionError(deletedProviders, failedProviders)
    }
    return { deletedProviders }
  }

  private async deleteTarget(
    roleId: RoleId,
    provider: ExternalProvider,
    signal?: AbortSignal
  ): Promise<void> {
    const raw = await this.execute(
      { operation: 'delete', target: targetFor(roleId, provider) },
      signal
    )
    this.requireMutationSuccess(raw)
  }

  private requireMutationSuccess(raw: unknown): void {
    const parsed = helperMutationResponseSchema.safeParse(raw)
    if (!parsed.success) {
      throw new CredentialVaultError(
        'protocol_error',
        'Credential helper returned an invalid response'
      )
    }
    if (!parsed.data.ok) throw helperFailure(parsed.data.errorCode)
  }

  private execute(request: HelperRequest, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    const payload = JSON.stringify(request)
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) {
      return Promise.reject(
        new CredentialVaultError('invalid_request', 'Credential request is invalid')
      )
    }

    let child: CredentialHelperProcess
    try {
      child = this.spawnProcess(this.executable, [], {
        shell: false,
        windowsHide: true,
        env: { ...this.childEnv },
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      return Promise.reject(
        new CredentialVaultError('process_error', 'Credential helper process failed')
      )
    }

    child.on('error', containLateProcessError)
    child.stdin.on('error', containLateProcessError)
    child.stdout.on('error', containLateProcessError)
    child.stderr.on('error', containLateProcessError)

    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let stdoutBytes = 0
      let stderrBytes = 0
      const stdoutChunks: Buffer[] = []

      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        child.stdout.off('data', onStdout)
        child.stdout.off('error', onProcessError)
        child.stderr.off('data', onStderr)
        child.stderr.off('error', onProcessError)
        child.stdin.off('error', onProcessError)
        child.off('error', onProcessError)
        child.off('close', onClose)
      }
      const terminate = (): void => {
        try {
          child.kill()
        } catch {
          // The operation is already settled and kill failures contain no actionable detail.
        }
      }
      const fail = (error: Error, kill = true): void => {
        if (settled) return
        settled = true
        cleanup()
        for (const chunk of stdoutChunks) chunk.fill(0)
        if (kill) terminate()
        reject(error)
      }
      const succeed = (value: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        for (const chunk of stdoutChunks) chunk.fill(0)
        resolve(value)
      }
      const onProcessError = (): void => {
        fail(new CredentialVaultError('process_error', 'Credential helper process failed'))
      }
      const onStdout = (chunk: Buffer | string): void => {
        const buffer = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk)
        stdoutBytes += buffer.length
        if (stdoutBytes > MAX_RESPONSE_BYTES) {
          buffer.fill(0)
          fail(
            new CredentialVaultError(
              'protocol_error',
              'Credential helper returned an invalid response'
            )
          )
          return
        }
        stdoutChunks.push(buffer)
      }
      const onStderr = (chunk: Buffer | string): void => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_RESPONSE_BYTES) {
          fail(
            new CredentialVaultError(
              'protocol_error',
              'Credential helper returned an invalid response'
            )
          )
        }
      }
      const onAbort = (): void => fail(abortError())
      const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
        if (settled) return
        if (code !== 0 || closeSignal !== null) {
          fail(new CredentialVaultError('process_error', 'Credential helper process failed'), false)
          return
        }
        let decoded: unknown
        let responseBuffer: Buffer | undefined
        try {
          responseBuffer = Buffer.concat(stdoutChunks, stdoutBytes)
          const responseText = new TextDecoder('utf-8', { fatal: true }).decode(responseBuffer)
          decoded = JSON.parse(responseText)
        } catch {
          fail(
            new CredentialVaultError(
              'protocol_error',
              'Credential helper returned an invalid response'
            ),
            false
          )
          return
        } finally {
          responseBuffer?.fill(0)
        }
        succeed(decoded)
      }
      const timer = setTimeout(
        () => fail(new CredentialVaultError('timeout', 'Credential helper operation timed out')),
        this.timeoutMs
      )

      child.stdout.on('data', onStdout)
      child.stdout.once('error', onProcessError)
      child.stderr.on('data', onStderr)
      child.stderr.once('error', onProcessError)
      child.stdin.once('error', onProcessError)
      child.once('error', onProcessError)
      child.once('close', onClose)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      if (settled) return
      try {
        child.stdin.end(payload)
      } catch {
        onProcessError()
      }
    })
  }
}
