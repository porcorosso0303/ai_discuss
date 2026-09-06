import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  CodexJsonRpcClient,
  JsonRpcProtocolError,
  JsonRpcServerError,
  JsonRpcTransportError
} from '../../../../src/main/providers/codex/jsonrpc-client'
import { resolveCodexBinaryPath } from '../../../../src/main/providers/codex/codex-path'
import {
  AI_DEBATES_CODEX_CONFIG,
  prepareCodexHome
} from '../../../../src/main/providers/codex/codex-config'
import {
  codexSpawnSpec,
  startCodexAppServer
} from '../../../../src/main/providers/codex/codex-process'
import {
  FakeCodexTransport,
  type FakeCodexMode
} from '../../../helpers/fake-codex-transport'

const clients: CodexJsonRpcClient[] = []
const temporaryPaths: string[] = []
const transports = new WeakMap<CodexJsonRpcClient, FakeCodexTransport>()

const exitedCodexTransport = (
  stdout: string,
  exitCode = 0,
  order: 'output-before-exit' | 'exit-before-output' = 'output-before-exit'
): FakeCodexTransport => {
  const child = new FakeCodexTransport()
  queueMicrotask(() => {
    child.exitCode = exitCode
    if (order === 'output-before-exit') {
      child.stdout.end(stdout)
      child.stderr.end()
      child.emit('exit', exitCode, null)
      child.emit('close', exitCode, null)
    } else {
      child.emit('exit', exitCode, null)
      queueMicrotask(() => {
        child.stdout.end(stdout)
        child.stderr.end()
        child.emit('close', exitCode, null)
      })
    }
  })
  return child
}

const startClient = async (
  mode: FakeCodexMode = 'normal',
  options: ConstructorParameters<typeof CodexJsonRpcClient>[1] = {},
  extraEnv: Record<string, string> = {}
): Promise<CodexJsonRpcClient> => {
  const child = new FakeCodexTransport({
    mode,
    secret: extraEnv.FAKE_SECRET,
    authUrl: extraEnv.FAKE_AUTH_URL
  })
  const client = new CodexJsonRpcClient(child, options)
  transports.set(client, child)
  clients.push(client)
  await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CodexJsonRpcClient', () => {
  it('performs initialize then initialized before allowing another request', async () => {
    const client = await startClient()

    await client.request('fast', {}, z.strictObject({ value: z.literal('fast') }))
    const messages = transports.get(client)?.transcript ?? []

    expect(messages.slice(0, 3).map(({ method }) => method)).toEqual([
      'initialize',
      'initialized',
      'fast'
    ])
    expect(messages[0].params).toEqual({
      clientInfo: { name: 'ai_debates', title: 'AI Debates', version: '0.1.0' },
      capabilities: null
    })
    expect(JSON.stringify(messages)).not.toContain('experimentalApi')
  })

  it('correlates concurrent responses by request ID and dispatches notifications', async () => {
    const client = await startClient()
    const values: number[] = []
    const remove = client.onNotification('test/notification', (params) => {
      values.push(z.strictObject({ value: z.number() }).parse(params).value)
    })

    const slow = client.request('slow', {}, z.strictObject({ value: z.string() }))
    const fast = client.request('fast', {}, z.strictObject({ value: z.string() }))
    await client.request('emit/notification', {}, z.strictObject({}))

    await expect(Promise.all([slow, fast])).resolves.toEqual([{ value: 'slow' }, { value: 'fast' }])
    expect(values).toEqual([7])
    remove()
  })

  it('maps server errors without leaking raw server messages', async () => {
    const client = await startClient('normal', {}, { FAKE_SECRET: 'rpc-secret' })
    const error = await client.request('server/error', {}, z.unknown()).catch((caught) => caught)

    expect(error).toBeInstanceOf(JsonRpcServerError)
    expect((error as JsonRpcServerError).code).toBe(429)
    expect((error as Error).message).not.toContain('rpc-secret')
  })

  it.each(['malformed', 'oversized'] as const)(
    'fails closed and cleans up pending work for %s stdout',
    async (mode) => {
      const child = new FakeCodexTransport({ mode })
      const client = new CodexJsonRpcClient(child, { maxLineBytes: 1024 })
      clients.push(client)

      await expect(
        client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
      ).rejects.toBeInstanceOf(JsonRpcProtocolError)
      expect(client.pendingCount).toBe(0)
    }
  )

  it('bounds and redacts captured stderr without surfacing it as protocol content', async () => {
    const client = await startClient(
      'stderr',
      { maxStderrBytes: 80 },
      { FAKE_SECRET: 'stderr-secret' }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(client.diagnostics.stderr.length).toBeLessThanOrEqual(80)
    expect(client.diagnostics.stderr).not.toContain('stderr-secret')
    expect(client.diagnostics.stderr).toBe('[REDACTED]')
  })

  it('rejects initialization on unexpected process exit', async () => {
    const child = new FakeCodexTransport({ mode: 'exit' })
    const client = new CodexJsonRpcClient(child)
    clients.push(client)

    await expect(
      client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
    ).rejects.toBeInstanceOf(JsonRpcTransportError)
    expect(client.pendingCount).toBe(0)
  })

  it('isolates failure listeners so one consumer cannot block cleanup', async () => {
    const child = new FakeCodexTransport()
    const client = new CodexJsonRpcClient(child)
    clients.push(client)
    await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
    const observed: Error[] = []
    client.onFailure(() => {
      throw new Error('hostile listener')
    })
    client.onFailure((error) => observed.push(error))

    child.exitCode = 9
    expect(() => child.emit('exit', 9, null)).not.toThrow()
    expect(observed).toHaveLength(1)
    expect(client.pendingCount).toBe(0)
  })

  it('enforces pending request limits and timeouts', async () => {
    const client = await startClient('normal', { maxPending: 1, requestTimeoutMs: 60 })
    const hanging = client.request('never/respond', {}, z.unknown())

    await expect(client.request('fast', {}, z.unknown())).rejects.toBeInstanceOf(JsonRpcProtocolError)
    await expect(hanging).rejects.toBeInstanceOf(JsonRpcTransportError)
    expect(client.pendingCount).toBe(0)
  })

  it('atomically fails the whole connection on timeout and ignores late bytes', async () => {
    const client = await startClient('normal', { maxPending: 2, requestTimeoutMs: 30 })
    const child = transports.get(client) as FakeCodexTransport
    const failures: Error[] = []
    client.onFailure((error) => failures.push(error))

    const first = client.request('never/respond', { request: 1 }, z.unknown())
    const second = client.request('never/respond', { request: 2 }, z.unknown())

    await expect(first).rejects.toBeInstanceOf(JsonRpcTransportError)
    await expect(second).rejects.toBeInstanceOf(JsonRpcTransportError)
    expect(failures).toHaveLength(1)
    expect(client.pendingCount).toBe(0)
    expect(child.exitCode).toBe(0)

    child.stdout.emit(
      'data',
      Buffer.from('{"id":2,"result":{"late":"must-be-ignored"}}\n')
    )
    await expect(client.request('fast', {}, z.unknown())).rejects.toBe(
      failures[0]
    )
    expect(failures).toHaveLength(1)
  })

  it('rejects initialize with an Error when dispose wins the startup race', async () => {
    const child = new FakeCodexTransport()
    child.stdin.removeAllListeners('data')
    const client = new CodexJsonRpcClient(child)
    clients.push(client)

    const initializing = client.initialize({
      name: 'ai_debates',
      title: 'AI Debates',
      version: '0.1.0'
    })
    await client.dispose()

    await expect(initializing).rejects.toBeInstanceOf(Error)
  })

  it('checks an oversized stdout remainder after every processed newline', async () => {
    const client = await startClient('normal', { maxLineBytes: 256 })
    const child = transports.get(client) as FakeCodexTransport
    const failed = new Promise<Error>((resolve) => client.onFailure(resolve))

    child.stdout.write(
      `${JSON.stringify({ method: 'unknown/notification', params: {} })}\n${'x'.repeat(257)}`
    )

    await expect(failed).resolves.toBeInstanceOf(JsonRpcProtocolError)
  })

  it('serializes writes behind drain without reordering messages', async () => {
    const client = await startClient('normal', {
      maxQueuedWrites: 3,
      maxQueuedWriteBytes: 2_048
    })
    const child = transports.get(client) as FakeCodexTransport
    const originalWrite = child.stdin.write.bind(child.stdin)
    let blocked = false
    let calls = 0
    Object.assign(child.stdin, {
      write: (chunk: Uint8Array | string) => {
        calls += 1
        const result = originalWrite(chunk)
        if (calls === 1) {
          blocked = true
          return false
        }
        expect(blocked).toBe(false)
        return result
      }
    })

    client.notify('test/one')
    client.notify('test/two')
    client.notify('test/three')
    expect(calls).toBe(1)

    blocked = false
    child.stdin.emit('drain')
    expect(calls).toBe(3)
    expect(child.transcript.slice(-3).map(({ method }) => method)).toEqual([
      'test/one',
      'test/two',
      'test/three'
    ])
  })

  it('fails closed when the bounded stdin queue fills during backpressure', async () => {
    const client = await startClient('normal', {
      maxQueuedWrites: 1,
      maxQueuedWriteBytes: 2_048
    })
    const child = transports.get(client) as FakeCodexTransport
    const originalWrite = child.stdin.write.bind(child.stdin)
    Object.assign(child.stdin, {
      write: (chunk: Uint8Array | string) => {
        originalWrite(chunk)
        return false
      }
    })

    client.notify('test/blocked')
    client.notify('test/queued')
    expect(() => client.notify('test/overflow')).toThrow(JsonRpcProtocolError)
    expect(child.exitCode).toBe(0)
  })

  it('rejects every server-initiated request with Method not found', async () => {
    const client = await startClient()

    await client.request('emit/server-request', {}, z.strictObject({}))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const messages = transports.get(client)?.transcript ?? []

    expect(messages).toContainEqual({
      id: 9001,
      error: { code: -32601, message: 'Method not found' }
    })
    expect(JSON.stringify(messages)).not.toContain('dangerously-accept')
  })

  it.each([
    ['emit/server-request-string', 'approval-request-1'],
    ['emit/server-request-int64', 9_223_372_036_854_775_000]
  ] as const)('rejects traced hostile requests with valid string/int64 IDs: %s', async (method, id) => {
    const client = await startClient()

    await client.request(method, {}, z.strictObject({}))
    const messages = transports.get(client)?.transcript ?? []

    expect(messages).toContainEqual({
      id,
      error: { code: -32601, message: 'Method not found' }
    })
    expect(JSON.stringify(messages)).not.toContain('steal credentials')
  })

  it.each([null, 1.5, 1e20])('fails the protocol for an invalid server request ID: %s', async (id) => {
    const client = await startClient()

    await expect(
      client.request('emit/server-request-invalid-id', { id }, z.strictObject({}))
    ).rejects.toBeInstanceOf(JsonRpcProtocolError)
  })

  it('fails the protocol for malformed W3C trace context', async () => {
    const client = await startClient()

    await expect(
      client.request('emit/server-request-invalid-trace', {}, z.strictObject({}))
    ).rejects.toBeInstanceOf(JsonRpcProtocolError)
  })

  it.each([
    ['max', '9223372036854775807'],
    ['min', '-9223372036854775808']
  ] as const)('echoes the exact signed int64 boundary token in Method not found: %s', async (variant, rawId) => {
    const client = await startClient()

    await client.request(
      'emit/server-request-raw',
      { case: variant },
      z.strictObject({})
    )
    const raw = transports.get(client)?.rawTranscript ?? []

    expect(raw).toContain(
      `{"id":${rawId},"error":{"code":-32601,"message":"Method not found"}}`
    )
  })

  it.each([
    'maxPlusOne',
    'minMinusOne',
    'exponent',
    'duplicateId',
    'duplicateEscapedId'
  ] as const)(
    'fails closed for a non-int64 raw server request ID: %s',
    async (variant) => {
      const client = await startClient()

      await expect(
        client.request(
          'emit/server-request-raw',
          { case: variant },
          z.strictObject({})
        )
      ).rejects.toBeInstanceOf(JsonRpcProtocolError)
    }
  )

  it('extracts only a top-level escaped string ID despite field order and nested IDs', async () => {
    const client = await startClient()

    await client.request(
      'emit/server-request-raw',
      { case: 'trickyString' },
      z.strictObject({})
    )
    const messages = transports.get(client)?.transcript ?? []

    expect(messages).toContainEqual({
      id: 'escaped"id\\taila',
      error: { code: -32601, message: 'Method not found' }
    })
  })
})

describe('Codex executable resolution', () => {
  it('uses only the packaged resources binary in production', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-resources-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    const packaged = join(resourcesPath, 'bin', 'codex.exe')
    await writeFile(packaged, 'fake')

    expect(
      resolveCodexBinaryPath({
        isPackaged: true,
        resourcesPath,
        env: { CODEX_BIN: join(resourcesPath, 'attacker.exe') }
      })
    ).toBe(packaged)
  })

  it('allows only an absolute existing file override in development', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-resources-'))
    temporaryPaths.push(resourcesPath)
    const binary = join(resourcesPath, 'codex-dev')
    await writeFile(binary, 'fake')

    expect(
      resolveCodexBinaryPath({ isPackaged: false, resourcesPath, env: { CODEX_BIN: binary } })
    ).toBe(binary)
    for (const invalid of ['codex.exe', `${binary}\0suffix`, join(resourcesPath, 'missing')]) {
      expect(() =>
        resolveCodexBinaryPath({
          isPackaged: false,
          resourcesPath,
          env: { CODEX_BIN: invalid }
        })
      ).toThrow()
    }
  })

  it('spawns the validated executable directly with only the stable app-server argument', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-resources-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    const packaged = join(resourcesPath, 'bin', 'codex.exe')
    await writeFile(packaged, 'fake')
    const codexHome = join(resourcesPath, 'codex-home')

    expect(
      codexSpawnSpec({
        isPackaged: true,
        resourcesPath,
        env: { PATH: '/attacker', CODEX_BIN: '/attacker/codex.exe' },
        codexHome,
        hostEnv: {
          SystemRoot: 'C:\\Windows',
          TEMP: 'C:\\safe-temp',
          OPENAI_API_KEY: 'must-not-leak',
          HTTPS_PROXY: 'http://proxy-with-credentials'
        },
        clientVersion: '0.1.0'
      })
    ).toMatchObject({
      command: packaged,
      args: ['app-server', '--strict-config'],
      options: {
        shell: false,
        windowsHide: true,
        env: {
          CODEX_HOME: codexHome,
          SystemRoot: 'C:\\Windows',
          TEMP: 'C:\\safe-temp'
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    })
  })

  it('atomically installs the exact app-owned configuration without overwriting auth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-home-test-'))
    temporaryPaths.push(root)
    const codexHome = join(root, 'home')
    await mkdir(codexHome)
    await writeFile(join(codexHome, 'auth.json'), '{"preserve":"chatgpt"}')
    await writeFile(join(codexHome, 'config.toml'), 'sandbox_mode = "danger-full-access"\n')

    await prepareCodexHome(codexHome)

    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(
      AI_DEBATES_CODEX_CONFIG
    )
    expect(await readFile(join(codexHome, 'auth.json'), 'utf8')).toBe(
      '{"preserve":"chatgpt"}'
    )
    expect(AI_DEBATES_CODEX_CONFIG).toContain('default_permissions = "ai-debates"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('forced_login_method = "chatgpt"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('persistence = "none"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('web_search = "disabled"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('inherit = "none"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('ignore_default_excludes = false')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('":root" = "deny"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('":minimal" = "read"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('"." = "read"')
    expect(AI_DEBATES_CODEX_CONFIG).toContain('enabled = false')
    for (const feature of [
      'shell_tool',
      'unified_exec',
      'apps',
      'multi_agent',
      'hooks',
      'goals',
      'skill_mcp_dependency_install',
      'shell_snapshot'
    ]) {
      expect(AI_DEBATES_CODEX_CONFIG).toContain(`${feature} = false`)
    }
    expect(AI_DEBATES_CODEX_CONFIG).not.toContain('[tools]')
    expect(AI_DEBATES_CODEX_CONFIG).not.toContain('view_image')
    expect(AI_DEBATES_CODEX_CONFIG).not.toContain('sandbox_mode')
  })

  it('rejects relative and symlinked app Codex homes or config files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-home-boundary-'))
    temporaryPaths.push(root)
    const realHome = join(root, 'real-home')
    const linkedHome = join(root, 'linked-home')
    await mkdir(realHome)
    await symlink(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(prepareCodexHome('relative-home')).rejects.toThrow()
    await expect(prepareCodexHome(linkedHome)).rejects.toThrow()

    if (process.platform !== 'win32') {
      const configLinkHome = join(root, 'config-link-home')
      await mkdir(configLinkHome)
      const outside = join(root, 'outside.toml')
      await writeFile(outside, 'do-not-overwrite')
      await symlink(outside, join(configLinkHome, 'config.toml'))
      await expect(prepareCodexHome(configLinkHome)).rejects.toThrow()
      expect(await readFile(outside, 'utf8')).toBe('do-not-overwrite')
    }
  })

  it('prepares the isolated home before spawning and completes the stable handshake', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-start-boundary-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    await writeFile(join(resourcesPath, 'bin', 'codex.exe'), 'fake')
    const codexHome = join(resourcesPath, 'codex-home')
    const child = new FakeCodexTransport()
    const spawnedArgs: (readonly string[])[] = []
    let observed:
      | { command: string; args: readonly string[]; options: { env?: NodeJS.ProcessEnv } }
      | undefined

    const client = await startCodexAppServer({
      isPackaged: true,
      resourcesPath,
      codexHome,
      clientVersion: '0.1.0',
      hostEnv: { SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'never-forward' },
      spawnProcess: (command, args, options) => {
        spawnedArgs.push(args)
        if (args[0] === '--version') {
          return exitedCodexTransport('codex-cli 0.147.0\r\n')
        }
        observed = { command, args, options }
        return child
      }
    })
    clients.push(client)

    expect(spawnedArgs).toEqual([
      ['--version'],
      ['app-server', '--strict-config']
    ])
    expect(observed?.args).toEqual(['app-server', '--strict-config'])
    expect(observed?.options.env).toEqual({
      CODEX_HOME: codexHome,
      SystemRoot: 'C:\\Windows'
    })
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(
      AI_DEBATES_CODEX_CONFIG
    )
    expect(child.transcript.slice(0, 2).map(({ method }) => method)).toEqual([
      'initialize',
      'initialized'
    ])
    expect(AI_DEBATES_CODEX_CONFIG).not.toContain('[tools]')
    expect(AI_DEBATES_CODEX_CONFIG).not.toContain('experimental')
  })

  it.each([
    'codex-cli 0.146.0\n',
    'codex-cli 0.147.1\n',
    'codex-cli 0.147.0 extra\n',
    'not-codex\n',
    ''
  ])('rejects a Codex binary that is not exactly stable 0.147.0: %j', async (output) => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-version-boundary-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    await writeFile(join(resourcesPath, 'bin', 'codex.exe'), 'fake')
    const server = new FakeCodexTransport()
    const spawnProcess = vi.fn((
      _command: string,
      args: readonly string[]
    ) => args[0] === '--version' ? exitedCodexTransport(output) : server)

    await expect(
      startCodexAppServer({
        isPackaged: true,
        resourcesPath,
        codexHome: join(resourcesPath, 'codex-home'),
        clientVersion: '0.1.0',
        spawnProcess
      })
    ).rejects.toThrow(/version/i)
    expect(server.transcript).toEqual([])
  })

  it('waits for process close so stdout emitted after exit can prove version 0.147.0', async () => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-version-close-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    await writeFile(join(resourcesPath, 'bin', 'codex.exe'), 'fake')
    const server = new FakeCodexTransport()

    const client = await startCodexAppServer({
      isPackaged: true,
      resourcesPath,
      codexHome: join(resourcesPath, 'codex-home'),
      clientVersion: '0.1.0',
      spawnProcess: (_command, args) =>
        args[0] === '--version'
          ? exitedCodexTransport('codex-cli 0.147.0\n', 0, 'exit-before-output')
          : server
    })
    clients.push(client)

    expect(server.transcript.slice(0, 2).map(({ method }) => method)).toEqual([
      'initialize',
      'initialized'
    ])
  })

  it.each([
    {
      name: 'overflow',
      createVersion: () => exitedCodexTransport('x'.repeat(1_025))
    },
    {
      name: 'nonzero exit',
      createVersion: () => exitedCodexTransport('codex-cli 0.147.0\n', 1)
    },
    {
      name: 'process error',
      createVersion: () => {
        const child = new FakeCodexTransport()
        queueMicrotask(() => child.emit('error', new Error('private spawn error')))
        return child
      }
    }
  ])('rejects version $name without starting app-server', async ({ createVersion }) => {
    const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-version-failure-'))
    temporaryPaths.push(resourcesPath)
    await mkdir(join(resourcesPath, 'bin'))
    await writeFile(join(resourcesPath, 'bin', 'codex.exe'), 'fake')
    const server = new FakeCodexTransport()

    await expect(
      startCodexAppServer({
        isPackaged: true,
        resourcesPath,
        codexHome: join(resourcesPath, 'codex-home'),
        clientVersion: '0.1.0',
        spawnProcess: (_command, args) =>
          args[0] === '--version' ? createVersion() : server
      })
    ).rejects.toThrow(/version/i)
    expect(server.transcript).toEqual([])
  })

  it('times out after exit when the version process never closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const resourcesPath = await mkdtemp(join(tmpdir(), 'codex-version-timeout-'))
      temporaryPaths.push(resourcesPath)
      await mkdir(join(resourcesPath, 'bin'))
      await writeFile(join(resourcesPath, 'bin', 'codex.exe'), 'fake')
      const server = new FakeCodexTransport()
      let versionSpawned = false
      const starting = startCodexAppServer({
        isPackaged: true,
        resourcesPath,
        codexHome: join(resourcesPath, 'codex-home'),
        clientVersion: '0.1.0',
        spawnProcess: (_command, args) => {
          if (args[0] !== '--version') return server
          versionSpawned = true
          const child = new FakeCodexTransport()
          queueMicrotask(() => {
            child.exitCode = 0
            child.stdout.end('codex-cli 0.147.0\n')
            child.emit('exit', 0, null)
          })
          return child
        }
      })
      while (!versionSpawned) {
        await new Promise((resolve) => setImmediate(resolve))
      }

      const rejection = expect(starting).rejects.toThrow(/version/i)
      await vi.advanceTimersByTimeAsync(5_001)
      await rejection
      expect(server.transcript).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it.skipIf(!process.env.CODEX_LIVE_0147_BIN)(
    'initializes a real Codex 0.147 app server with the isolated strict configuration',
    async () => {
      const binary = process.env.CODEX_LIVE_0147_BIN
      if (!binary) throw new Error('CODEX_LIVE_0147_BIN must name the native Codex binary')
      const root = await mkdtemp(join(tmpdir(), 'codex-live-0147-'))
      temporaryPaths.push(root)
      const client = await startCodexAppServer({
        isPackaged: false,
        resourcesPath: root,
        env: { CODEX_BIN: binary },
        codexHome: join(root, 'codex-home'),
        clientVersion: '0.1.0',
        hostEnv: { TMPDIR: tmpdir(), LANG: 'C.UTF-8' }
      })
      clients.push(client)

      expect(await readFile(join(root, 'codex-home', 'config.toml'), 'utf8')).toBe(
        AI_DEBATES_CODEX_CONFIG
      )
    }
  )
})
