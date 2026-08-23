import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CredentialRoleDeletionError,
  CredentialVault,
  CredentialVaultError,
  resolveCredentialHelperPath,
  type CredentialHelperProcess,
  type CredentialHelperSpawn
} from '../../../src/main/security/credential-vault'

const temporaryPaths: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class FakeHelperProcess extends EventEmitter implements CredentialHelperProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

const fakeExecutable = async (): Promise<{ resourcesPath: string; executable: string }> => {
  const resourcesPath = await mkdtemp(join(tmpdir(), 'credential-helper-'))
  temporaryPaths.push(resourcesPath)
  await mkdir(join(resourcesPath, 'bin'))
  const executable = join(resourcesPath, 'bin', 'credential-helper.exe')
  await writeFile(executable, 'fake')
  return { resourcesPath, executable }
}

const respondingSpawn = (
  respond: (request: Record<string, unknown>, process: FakeHelperProcess) => unknown
): { spawn: CredentialHelperSpawn; calls: Array<{ command: string; args: readonly string[]; options: unknown; input: string }>; processes: FakeHelperProcess[] } => {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown; input: string }> = []
  const processes: FakeHelperProcess[] = []
  const spawn: CredentialHelperSpawn = (command, args, options) => {
    const process = new FakeHelperProcess()
    processes.push(process)
    let input = ''
    process.stdin.on('data', (chunk) => {
      input += chunk.toString()
    })
    process.stdin.once('end', () => {
      const request = JSON.parse(input) as Record<string, unknown>
      calls.push({ command, args, options, input })
      const response = respond(request, process)
      if (response !== undefined) process.stdout.end(`${JSON.stringify(response)}\n`)
      process.stderr.end()
      queueMicrotask(() => process.emit('close', 0, null))
    })
    return process
  }
  return { spawn, calls, processes }
}

const kimiScope = {
  roleId: 'role-a',
  provider: 'kimi',
  origin: 'https://api.moonshot.cn'
} as const

describe('credential helper executable resolution', () => {
  it('uses only the packaged resources binary in production', async () => {
    const { resourcesPath, executable } = await fakeExecutable()
    expect(
      resolveCredentialHelperPath({
        isPackaged: true,
        resourcesPath,
        env: { CREDENTIAL_HELPER_BIN: join(resourcesPath, 'attacker.exe') }
      })
    ).toBe(executable)
  })

  it('accepts only an absolute existing development override', async () => {
    const { resourcesPath, executable } = await fakeExecutable()
    expect(
      resolveCredentialHelperPath({
        isPackaged: false,
        resourcesPath,
        env: { CREDENTIAL_HELPER_BIN: executable }
      })
    ).toBe(executable)
    for (const value of ['credential-helper.exe', `${executable}\0tail`, join(resourcesPath, 'missing')]) {
      expect(() =>
        resolveCredentialHelperPath({
          isPackaged: false,
          resourcesPath,
          env: { CREDENTIAL_HELPER_BIN: value }
        })
      ).toThrow('Credential helper is unavailable')
    }
  })
})

describe('CredentialVault', () => {
  it('sends secrets only through bounded stdin and never argv or inherited secret env', async () => {
    const { resourcesPath, executable } = await fakeExecutable()
    const secret = 'sk-node-secret'
    const fake = respondingSpawn((request) => {
      expect(request).toEqual({
        operation: 'set',
        target: 'AI Debates/role-a/kimi',
        origin: 'https://api.moonshot.cn',
        secret
      })
      return { ok: true }
    })
    const vault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      spawnProcess: fake.spawn,
      hostEnv: {
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\safe-temp',
        API_SECRET: secret,
        HTTPS_PROXY: `https://user:${secret}@proxy.example`
      }
    })

    await expect(vault.set(kimiScope, secret)).resolves.toEqual({ stored: true })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({
      command: executable,
      args: [],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\safe-temp' }
      }
    })
    expect(JSON.stringify({ command: fake.calls[0].command, args: fake.calls[0].args, options: fake.calls[0].options })).not.toContain(secret)
    expect(fake.calls[0].input).toContain(secret)
  })

  it('gets only a secret bound to the canonical origin and represents absence as undefined', async () => {
    const { resourcesPath } = await fakeExecutable()
    const fake = respondingSpawn((request) =>
      request.origin === 'https://api.moonshot.cn'
        ? { ok: true, found: true, secret: 'bound-secret' }
        : { ok: true, found: false }
    )
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: fake.spawn })

    await expect(vault.get(kimiScope)).resolves.toBe('bound-secret')
    await expect(
      vault.get({ ...kimiScope, origin: 'https://compatible.example.com/v1' })
    ).resolves.toBeUndefined()
    expect(JSON.parse(fake.calls[1].input)).toEqual({
      operation: 'get',
      target: 'AI Debates/role-a/kimi',
      origin: 'https://compatible.example.com'
    })
  })

  it('validates scopes before spawn so callers cannot forge a target', async () => {
    const { resourcesPath } = await fakeExecutable()
    const spawn = vi.fn<CredentialHelperSpawn>()
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: spawn })

    await expect(
      vault.get({ roleId: 'role-c', provider: 'kimi', origin: 'https://api.moonshot.cn' } as never)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      vault.get({
        roleId: 'role-a',
        provider: 'kimi',
        origin: `https://${'a'.repeat(505)}.test`
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a secret that cannot round-trip through UTF-16 before spawn', async () => {
    const { resourcesPath } = await fakeExecutable()
    const spawn = vi.fn<CredentialHelperSpawn>()
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: spawn })

    await expect(vault.set(kimiScope, '\ud800')).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('enforces the Windows credential blob limit in UTF-16 code units', async () => {
    const { resourcesPath } = await fakeExecutable()
    const fake = respondingSpawn(() => ({ ok: true }))
    const vault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      spawnProcess: fake.spawn
    })
    const exactLimit = '\u{1f600}'.repeat(640)

    await expect(vault.set(kimiScope, exactLimit)).resolves.toEqual({ stored: true })
    await expect(vault.set(kimiScope, `${exactLimit}a`)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(fake.calls).toHaveLength(1)
  })

  it('strictly rejects malformed or operation-incompatible helper responses', async () => {
    const { resourcesPath } = await fakeExecutable()
    const responses = [
      { ok: true, found: false, secret: 'unexpected' },
      { ok: true, extra: true },
      { ok: false, errorCode: 'invented' }
    ]
    const fake = respondingSpawn(() => responses.shift())
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: fake.spawn })

    await expect(vault.get(kimiScope)).rejects.toMatchObject({ code: 'protocol_error' })
    await expect(vault.set(kimiScope, 'secret')).rejects.toMatchObject({ code: 'protocol_error' })
    await expect(vault.delete(kimiScope)).rejects.toMatchObject({ code: 'protocol_error' })
  })

  it('never includes requests, child stderr, or secrets in thrown errors', async () => {
    const { resourcesPath } = await fakeExecutable()
    const secret = 'do-not-leak-this'
    const fake = respondingSpawn((_request, process) => {
      process.stderr.write(`native failure: ${secret}`)
      return { ok: false, errorCode: 'storage_error' }
    })
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: fake.spawn })

    let error: unknown
    try {
      await vault.set(kimiScope, secret)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CredentialVaultError)
    expect(error).toMatchObject({ code: 'storage_error', message: 'Credential storage operation failed' })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect((error as Error).stack).not.toContain(secret)
  })

  it('bounds stdout and stderr and kills a helper that exceeds either limit', async () => {
    const { resourcesPath } = await fakeExecutable()
    for (const stream of ['stdout', 'stderr'] as const) {
      const process = new FakeHelperProcess()
      const spawn: CredentialHelperSpawn = () => process
      const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: spawn })
      const pending = vault.get(kimiScope)
      process[stream].write('x'.repeat(9_000))
      await expect(pending).rejects.toMatchObject({ code: 'protocol_error' })
      expect(process.killed).toBe(true)
    }
  })

  it('handles timeout, abort, spawn failure, and late close as one sanitized settlement', async () => {
    const { resourcesPath } = await fakeExecutable()

    const timedProcess = new FakeHelperProcess()
    const timedVault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      spawnProcess: () => timedProcess,
      timeoutMs: 5
    })
    await expect(timedVault.get(kimiScope)).rejects.toMatchObject({ code: 'timeout' })
    expect(timedProcess.killed).toBe(true)
    timedProcess.emit('close', 0, null)

    const abortedProcess = new FakeHelperProcess()
    const abortedVault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      spawnProcess: () => abortedProcess
    })
    const controller = new AbortController()
    const aborted = abortedVault.get(kimiScope, controller.signal)
    controller.abort(new Error('secret-bearing abort reason'))
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError', message: 'Credential operation aborted' })
    expect(abortedProcess.killed).toBe(true)

    const spawnVault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      spawnProcess: () => {
        throw new Error('spawn leaked secret-bearing data')
      }
    })
    await expect(spawnVault.get(kimiScope)).rejects.toMatchObject({
      code: 'process_error',
      message: 'Credential helper process failed'
    })
  })

  it('observes an abort that fires while the helper is being spawned', async () => {
    const { resourcesPath } = await fakeExecutable()
    const controller = new AbortController()
    const process = new FakeHelperProcess()
    const vault = new CredentialVault({
      isPackaged: true,
      resourcesPath,
      timeoutMs: 5,
      spawnProcess: () => {
        controller.abort(new Error('unsafe abort reason'))
        return process
      }
    })

    await expect(vault.get(kimiScope, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Credential operation aborted'
    })
    expect(process.killed).toBe(true)
  })

  it('deletes both provider targets for a role and reports partial failure after both attempts', async () => {
    const { resourcesPath } = await fakeExecutable()
    const fake = respondingSpawn((request) =>
      request.target === 'AI Debates/role-b/kimi'
        ? { ok: true }
        : { ok: false, errorCode: 'storage_error' }
    )
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: fake.spawn })

    let error: unknown
    try {
      await vault.deleteRoleSecrets('role-b')
    } catch (caught) {
      error = caught
    }
    expect(fake.calls.map(({ input }) => JSON.parse(input))).toEqual([
      { operation: 'delete', target: 'AI Debates/role-b/kimi' },
      { operation: 'delete', target: 'AI Debates/role-b/deepseek' }
    ])
    expect(error).toBeInstanceOf(CredentialRoleDeletionError)
    expect(error).toMatchObject({
      code: 'partial_delete',
      deletedProviders: ['kimi'],
      failedProviders: ['deepseek']
    })
  })

  it('propagates role deletion cancellation without attempting another provider', async () => {
    const { resourcesPath } = await fakeExecutable()
    const controller = new AbortController()
    const process = new FakeHelperProcess()
    const spawn = vi.fn<CredentialHelperSpawn>(() => process)
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: spawn })

    const pending = vault.deleteRoleSecrets('role-a', controller.signal)
    controller.abort(new Error('unsafe abort reason'))

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Credential operation aborted'
    })
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('returns explicit mutation results and rejects an invalid role deletion before spawn', async () => {
    const { resourcesPath } = await fakeExecutable()
    const fake = respondingSpawn(() => ({ ok: true }))
    const vault = new CredentialVault({ isPackaged: true, resourcesPath, spawnProcess: fake.spawn })

    await expect(vault.delete(kimiScope)).resolves.toEqual({ deleted: true })
    await expect(vault.deleteRoleSecrets('role-a')).resolves.toEqual({
      deletedProviders: ['kimi', 'deepseek']
    })
    const callsBeforeInvalid = fake.calls.length
    await expect(vault.deleteRoleSecrets('role-c' as never)).rejects.toMatchObject({
      code: 'invalid_request'
    })
    expect(fake.calls).toHaveLength(callsBeforeInvalid)
  })
})
