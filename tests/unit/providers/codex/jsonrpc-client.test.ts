import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  CodexJsonRpcClient,
  JsonRpcProtocolError,
  JsonRpcServerError,
  JsonRpcTransportError
} from '../../../../src/main/providers/codex/jsonrpc-client'
import { resolveCodexBinaryPath } from '../../../../src/main/providers/codex/codex-path'
import { codexSpawnSpec } from '../../../../src/main/providers/codex/codex-process'
import {
  FakeCodexTransport,
  type FakeCodexMode
} from '../../../helpers/fake-codex-transport'

const clients: CodexJsonRpcClient[] = []
const transports = new WeakMap<CodexJsonRpcClient, FakeCodexTransport>()

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
    await mkdir(join(resourcesPath, 'bin'))
    const packaged = join(resourcesPath, 'bin', 'codex.exe')
    await writeFile(packaged, 'fake')

    expect(
      codexSpawnSpec({
        isPackaged: true,
        resourcesPath,
        env: { PATH: '/attacker', CODEX_BIN: '/attacker/codex.exe' },
        clientVersion: '0.1.0'
      })
    ).toMatchObject({
      command: packaged,
      args: ['app-server'],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    })
  })
})
