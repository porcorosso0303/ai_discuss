import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexJsonRpcClient } from '../../src/main/providers/codex/jsonrpc-client'
import { CodexProvider } from '../../src/main/providers/codex/codex-provider'
import {
  ProviderNonRetryableError,
  ProviderRetryableError
} from '../../src/main/providers/provider'
import type { OpenAIRoleConfig } from '../../src/shared/domain'
import type { ProviderChunk, ProviderReplyRequest } from '../../src/main/providers/provider'
import {
  FakeCodexTransport,
  type FakeCodexMode
} from '../helpers/fake-codex-transport'

const providers: CodexProvider[] = []

const role = (overrides: Partial<OpenAIRoleConfig> = {}): OpenAIRoleConfig => ({
  roleId: 'role-a',
  name: '甲方',
  personaOrStance: '支持创新',
  provider: 'openai',
  model: 'gpt-test',
  effort: 'high',
  ...overrides
})

const request = (config = role()): ProviderReplyRequest => ({
  sessionId: 'session-contract',
  turn: 3,
  role: config,
  view: {
    system: 'SYSTEM CONTRACT',
    messages: [{ role: 'user', content: '对方反驳' }],
    waiting: false
  }
})

const createProvider = async (
  mode: FakeCodexMode = 'normal',
  extraEnv: Record<string, string> = {},
  openExternal = vi.fn(async () => undefined),
  overrides: Partial<
    Pick<
      ConstructorParameters<typeof CodexProvider>[0],
      'createEmptyCwd' | 'removeEmptyCwd' | 'turnTimeoutMs'
    >
  > = {}
): Promise<{
  provider: CodexProvider
  client: CodexJsonRpcClient
  transcript: Array<Record<string, any>>
  openExternal: typeof openExternal
  cwdPaths: string[]
}> => {
  const child = new FakeCodexTransport({
    mode,
    authUrl: extraEnv.FAKE_AUTH_URL,
    secret: extraEnv.FAKE_SECRET
  })
  const client = new CodexJsonRpcClient(child)
  await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
  const cwdPaths: string[] = []
  const provider = new CodexProvider({
    createClient: async () => client,
    openExternal,
    createEmptyCwd:
      overrides.createEmptyCwd ??
      (async (roleId) => {
        const cwd = await mkdtemp(join(tmpdir(), `ai-debates-${roleId}-`))
        cwdPaths.push(cwd)
        return cwd
      }),
    removeEmptyCwd:
      overrides.removeEmptyCwd ??
      (async (path) => rm(path, { recursive: true, force: true })),
    turnTimeoutMs: overrides.turnTimeoutMs
  })
  providers.push(provider)
  return { provider, client, transcript: child.transcript, openExternal, cwdPaths }
}

const collect = async (iterable: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const chunks: ProviderChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

const SUCCESSFUL_REPLY: ProviderChunk[] = [
  { type: 'content', content: '{"speech":"回应","status":"continue"}' },
  {
    type: 'usage',
    usage: {
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 18,
      reasoningTokens: 2,
      cacheReadTokens: 3
    }
  },
  { type: 'final', finishReason: 'stop' }
]

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('Timed out waiting for fake Codex protocol state')
}

const createProviderFactorySequence = (
  modes: readonly FakeCodexMode[],
  rpc: ConstructorParameters<typeof CodexJsonRpcClient>[1] = {}
): {
  provider: CodexProvider
  createClient: ReturnType<typeof vi.fn<() => Promise<CodexJsonRpcClient>>>
  clients: CodexJsonRpcClient[]
  children: FakeCodexTransport[]
} => {
  const clients: CodexJsonRpcClient[] = []
  const children: FakeCodexTransport[] = []
  let index = 0
  const createClient = vi.fn(async () => {
    const mode = modes[Math.min(index, modes.length - 1)] as FakeCodexMode
    index += 1
    const child = new FakeCodexTransport({ mode })
    const client = new CodexJsonRpcClient(child, rpc)
    children.push(child)
    clients.push(client)
    await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
    return client
  })
  const provider = new CodexProvider({
    createClient,
    openExternal: async () => undefined,
    removeEmptyCwd: async (path) => rm(path, { recursive: true, force: true })
  })
  providers.push(provider)
  return { provider, createClient, clients, children }
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.dispose()))
})

describe('CodexProvider authentication', () => {
  it('reads only safe ChatGPT account status and never asks for a token', async () => {
    const { provider, transcript } = await createProvider()

    await expect(provider.readAccount()).resolves.toEqual({
      signedIn: true,
      requiresOpenaiAuth: true,
      planType: 'plus'
    })
    const text = JSON.stringify(transcript)
    expect(text).toContain('"method":"account/read"')
    expect(text).toContain('"refreshToken":false')
    expect(text).not.toContain('apiKey')
    expect(JSON.stringify(await provider.readAccount())).not.toContain('private@example.com')
  })

  it('starts and completes the browser ChatGPT flow, then logs out', async () => {
    const { provider, openExternal, transcript } = await createProvider()

    const login = await provider.startChatGptLogin()
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/oauth/authorize?private=yes')
    await expect(login.completion).resolves.toBeUndefined()
    await expect(provider.logout()).resolves.toBeUndefined()
    const messages = transcript
    expect(messages.find(({ method }) => method === 'account/login/start')?.params).toEqual({
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt'
    })
    expect(messages.find(({ method }) => method === 'account/logout')).not.toHaveProperty('params')
  })

  it('supports explicit cancellation of an in-flight ChatGPT login', async () => {
    const { provider, transcript } = await createProvider()
    const login = await provider.startChatGptLogin()
    await provider.cancelChatGptLogin(login.loginId)

    const text = JSON.stringify(transcript)
    expect(text).toContain('"method":"account/login/cancel"')
    expect(text).toContain('"loginId":"login-1"')
  })

  it('settles local login state when cancel succeeds without a completion notification', async () => {
    const { provider } = await createProvider('login-no-completion')
    const first = await provider.startChatGptLogin()

    await provider.cancelChatGptLogin(first.loginId)
    await expect(first.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)

    const second = await provider.startChatGptLogin()
    expect(second.loginId).toBe('login-2')
    await provider.cancelChatGptLogin(second.loginId)
    await expect(second.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('does not release the active login when a stale cancel returns notFound', async () => {
    const { provider } = await createProvider('login-no-completion')
    const active = await provider.startChatGptLogin()

    await expect(provider.cancelChatGptLogin('stale-login')).resolves.toBeUndefined()
    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )

    await provider.cancelChatGptLogin(active.loginId)
    await expect(active.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('locally closes the current login when cancel returns notFound and ignores late completion', async () => {
    const { provider } = await createProvider('login-current-not-found')
    const missing = await provider.startChatGptLogin()

    await provider.cancelChatGptLogin(missing.loginId)
    const active = await provider.startChatGptLogin()
    await expect(missing.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )

    await provider.cancelChatGptLogin(active.loginId)
    await expect(active.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('does not release a newer login when canceling an already completed login ID', async () => {
    const { provider } = await createProvider('login-first-completes')
    const completed = await provider.startChatGptLogin()
    await completed.completion
    const active = await provider.startChatGptLogin()

    await provider.cancelChatGptLogin(completed.loginId)
    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )

    await provider.cancelChatGptLogin(active.loginId)
    await expect(active.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('ignores a late completion for a canceled login without settling the next login', async () => {
    const { provider } = await createProvider('login-late-completion')
    const canceled = await provider.startChatGptLogin()
    await provider.cancelChatGptLogin(canceled.loginId)
    await expect(canceled.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
    const active = await provider.startChatGptLogin()

    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )

    await provider.cancelChatGptLogin(active.loginId)
    await expect(active.completion).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('allows only one in-flight browser login attempt', async () => {
    const { provider } = await createProvider()
    const first = await provider.startChatGptLogin()

    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )
    await first.completion
  })

  it.each([
    'http://auth.openai.com/login',
    'https://auth.openai.com:444/login',
    'https://user@auth.openai.com/login',
    'https://openai.com.evil.test/login',
    'https://fakechatgpt.com/login',
    'https://xn--openai-9za.com/login'
  ])('rejects an unsafe login URL without opening it: %s', async (authUrl) => {
    const { provider, openExternal } = await createProvider('normal', { FAKE_AUTH_URL: authUrl })

    await expect(provider.startChatGptLogin()).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('CodexProvider discovery and debate streaming', () => {
  it('refuses to use a pre-existing API-key account for OpenAI debates', async () => {
    const { provider, transcript } = await createProvider('api-key-account')

    await expect(provider.discover(role())).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(JSON.stringify(transcript)).not.toContain('sk-')
    expect(transcript.some(({ method }) => method === 'model/list')).toBe(false)
  })

  it('paginates model/list and maps text models, defaults, and reasoning efforts', async () => {
    const { provider } = await createProvider()

    await expect(provider.discover(role())).resolves.toEqual({
      provider: 'openai',
      defaultModel: 'gpt-test',
      models: [
        {
          id: 'gpt-test',
          displayName: 'GPT-TEST',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low',
          inputModalities: ['text'],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-schema']
        },
        {
          id: 'gpt-second',
          displayName: 'GPT-SECOND',
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'low',
          inputModalities: ['text'],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-schema']
        }
      ]
    })
  })

  it.each(['duplicate-models', 'malformed-catalog'] as const)(
    'rejects an unsafe %s catalog',
    async (mode) => {
      const { provider } = await createProvider(mode)
      await expect(provider.discover(role())).rejects.toBeInstanceOf(ProviderNonRetryableError)
    }
  )

  it('rejects selected models and efforts missing from the discovered catalog', async () => {
    const { provider } = await createProvider()

    await expect(provider.discover(role({ model: 'missing' }))).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )
    await expect(provider.discover(role({ effort: 'max' }))).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )
  })

  it('rejects malformed thread/start payloads instead of accepting unknown fields', async () => {
    const { provider } = await createProvider('malformed-thread')
    await provider.discover(role())

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('creates isolated safe threads and yields only matching agent-message content', async () => {
    const { provider, transcript, cwdPaths } = await createProvider()
    await provider.discover(role())
    await provider.discover(role({ roleId: 'role-b' }))

    const chunksA = await collect(provider.streamReply(request(), new AbortController().signal))
    const chunksB = await collect(
      provider.streamReply(request(role({ roleId: 'role-b' })), new AbortController().signal)
    )

    expect(chunksA).toEqual(SUCCESSFUL_REPLY)
    expect(chunksB).toEqual(chunksA)
    expect(JSON.stringify(chunksA)).not.toMatch(/SECRET_REASONING|WRONG|private/i)

    const messages = transcript
    const starts = messages.filter(({ method }) => method === 'thread/start')
    expect(starts).toHaveLength(2)
    expect(starts[0].params.cwd).not.toBe(starts[1].params.cwd)
    for (const { params } of starts) {
      expect(params).toMatchObject({
        model: 'gpt-test',
        approvalPolicy: 'never',
        ephemeral: true,
        serviceName: 'ai_debates'
      })
      expect(params).not.toHaveProperty('sandbox')
      expect(params).not.toHaveProperty('runtimeWorkspaceRoots')
    }
    const turns = messages.filter(({ method }) => method === 'turn/start')
    for (const { params } of turns) {
      expect(params).toMatchObject({
        approvalPolicy: 'never',
        model: 'gpt-test',
        effort: 'high'
      })
      expect(params).not.toHaveProperty('sandboxPolicy')
      expect(params).not.toHaveProperty('runtimeWorkspaceRoots')
      expect(params.outputSchema).toEqual({
        type: 'object',
        properties: {
          speech: { type: 'string', minLength: 1, maxLength: 200000 },
          status: { type: 'string', enum: ['continue', 'concede', 'agree'] }
        },
        required: ['speech', 'status'],
        additionalProperties: false
      })
      expect(params.input[0]).toMatchObject({ type: 'text', text_elements: [] })
    }
    await Promise.all(cwdPaths.map((cwd) => expect(access(cwd)).rejects.toThrow()))
  })

  it('uses a fresh ephemeral thread for every reply and renders each supplied view once', async () => {
    const { provider, transcript, cwdPaths } = await createProvider()
    await provider.discover(role())
    const firstRequest = request()
    firstRequest.view = {
      system:
        'FIRST_SYSTEM_SENTINEL TOPIC_SENTINEL ROLE_A_STANCE_SENTINEL ROLE_B_STANCE_SENTINEL',
      messages: [{ role: 'user', content: 'FIRST_MESSAGE_SENTINEL' }],
      waiting: false
    }
    const secondRequest = request()
    secondRequest.turn = 4
    secondRequest.view = {
      system: 'SECOND_SYSTEM_SENTINEL',
      messages: [
        { role: 'assistant', content: 'LOCAL_HISTORY_SENTINEL' },
        { role: 'user', content: 'SECOND_MESSAGE_SENTINEL' }
      ],
      waiting: false
    }

    await collect(provider.streamReply(firstRequest, new AbortController().signal))
    await collect(provider.streamReply(secondRequest, new AbortController().signal))

    const starts = transcript.filter(({ method }) => method === 'thread/start')
    const turns = transcript.filter(({ method }) => method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(starts.map(({ params }) => params.cwd)).toEqual([
      expect.any(String),
      expect.any(String)
    ])
    expect(starts[0].params.cwd).not.toBe(starts[1].params.cwd)
    expect(turns.map(({ params }) => params.threadId)).toEqual(['thread-1', 'thread-2'])
    const firstInput = turns[0].params.input[0].text as string
    const secondInput = turns[1].params.input[0].text as string
    expect(firstInput.match(/FIRST_SYSTEM_SENTINEL/g)).toHaveLength(1)
    expect(firstInput.match(/FIRST_MESSAGE_SENTINEL/g)).toHaveLength(1)
    expect(secondInput.match(/SECOND_SYSTEM_SENTINEL/g)).toHaveLength(1)
    expect(secondInput.match(/LOCAL_HISTORY_SENTINEL/g)).toHaveLength(1)
    expect(secondInput.match(/SECOND_MESSAGE_SENTINEL/g)).toHaveLength(1)
    expect(secondInput).not.toContain('FIRST_MESSAGE_SENTINEL')
    const firstWire = JSON.stringify([starts[0], turns[0]])
    for (const sentinel of [
      'FIRST_SYSTEM_SENTINEL',
      'TOPIC_SENTINEL',
      'ROLE_A_STANCE_SENTINEL',
      'ROLE_B_STANCE_SENTINEL',
      'FIRST_MESSAGE_SENTINEL'
    ]) {
      expect(firstWire.match(new RegExp(sentinel, 'g'))).toHaveLength(1)
    }
    expect(starts[0].params).not.toHaveProperty('baseInstructions')
    await Promise.all(cwdPaths.map((cwd) => expect(access(cwd)).rejects.toThrow()))
  })

  it.each(['turn-failed', 'turn-interrupted'] as const)(
    'fails safely when the matching turn is %s',
    async (mode) => {
      const { provider } = await createProvider(mode)
      await provider.discover(role())
      await expect(
        collect(provider.streamReply(request(), new AbortController().signal))
      ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    }
  )

  it.each([
    'empty-turn',
    'malformed-delta',
    'oversized-delta'
  ] as const)('rejects a hostile or invalid active stream: %s', async (mode) => {
    const { provider } = await createProvider(mode)
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(Error)
  })

  it.each([
    'commentary-then-final',
    'commentary-delta-before-start',
    'null-start-commentary-completed',
    'final-delta-before-start',
    'final-authoritative-mismatch',
    'legacy-null-phase',
    'usage-updates',
    'old-malformed-usage'
  ] as const)('streams only final answer text with correlated latest usage: %s', async (mode) => {
    const { provider } = await createProvider(mode)
    await provider.discover(role())

    const chunks = await collect(provider.streamReply(request(), new AbortController().signal))
    expect(chunks).toEqual(SUCCESSFUL_REPLY)
    expect(JSON.stringify(chunks)).not.toMatch(/PRIVATE_COMMENTARY|NOT_JSON/)
  })

  it.each(['hostile-item', 'malformed-item'] as const)(
    'fails and interrupts before exposing a hostile current-turn event: %s',
    async (mode) => {
      const { provider, transcript } = await createProvider(mode)
      await provider.discover(role())
      const iterator = provider
        .streamReply(request(), new AbortController().signal)
        [Symbol.asyncIterator]()

      await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
      await waitUntil(() => transcript.some(({ method }) => method === 'turn/interrupt'))
      expect(transcript.filter(({ method }) => method === 'turn/interrupt')).toEqual([
        expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
      ])
    }
  )

  it('rejects malformed matching usage without accepting the completion', async () => {
    const { provider, transcript } = await createProvider('malformed-usage')
    await provider.discover(role())

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/interrupt'))
  })

  it.each(['hostile-completion-item', 'unknown-completion-item'] as const)(
    'fails closed before visibility when completion reveals a forbidden item: %s',
    async (mode) => {
      const { provider } = await createProvider(mode)
      await provider.discover(role())
      const iterator = provider
        .streamReply(request(), new AbortController().signal)
        [Symbol.asyncIterator]()

      await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
    }
  )

  it.each(['turn-server-overloaded', 'turn-rate-limited'] as const)(
    'maps official transient turn failures to retryable provider errors: %s',
    async (mode) => {
      const { provider } = await createProvider(mode)
      await provider.discover(role())
      const error = await collect(
        provider.streamReply(request(), new AbortController().signal)
      ).catch((caught) => caught)

      expect(error).toBeInstanceOf(ProviderRetryableError)
      expect((error as Error).message).not.toMatch(/private|429|serverOverloaded/i)
    }
  )

  it('maps official authentication turn failures to a nonretryable safe error', async () => {
    const { provider } = await createProvider('turn-unauthorized')
    await provider.discover(role())
    const error = await collect(
      provider.streamReply(request(), new AbortController().signal)
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderNonRetryableError)
    expect(error).not.toBeInstanceOf(ProviderRetryableError)
    expect((error as Error).message).not.toMatch(/private|unauthorized/i)
  })

  it('maps the official JSON-RPC overload code to a retryable safe error', async () => {
    const { provider } = await createProvider('rpc-overloaded-account')
    const error = await provider.readAccount().catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderRetryableError)
    expect((error as Error).message).not.toContain('private overload detail')
  })

  it.each([
    'pre-response-event-flood',
    'queued-empty-delta-flood',
    'pre-response-byte-flood'
  ] as const)('rejects bounded matching event floods: %s', async (mode) => {
    const { provider } = await createProvider(mode)
    await provider.discover(role())

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('filters unrelated-thread floods before consuming the active turn event budget', async () => {
    const { provider } = await createProvider('unrelated-thread-flood')
    await provider.discover(role())

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual(SUCCESSFUL_REPLY)
  })

  it.each([
    'malformed-old-delta',
    'malformed-old-completion'
  ] as const)('ignores malformed late events for an older turn: %s', async (mode) => {
    const { provider } = await createProvider(mode)
    await provider.discover(role())

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual(SUCCESSFUL_REPLY)
  })

  it('rejects an active turn immediately when the App Server process crashes', async () => {
    const { provider, client } = await createProvider('crash-active')
    const failures: Error[] = []
    client.onFailure((error) => failures.push(error))
    await provider.discover(role())

    const outcome = await Promise.race([
      collect(provider.streamReply(request(), new AbortController().signal)).then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])

    expect(failures).toHaveLength(1)
    expect(outcome).toBe('rejected')
  })

  it('retries on a newly initialized connection after timeout and ignores the old late response', async () => {
    const { provider, createClient, children } = createProviderFactorySequence(
      ['timeout-account', 'normal'],
      { requestTimeoutMs: 25 }
    )

    await expect(provider.readAccount()).rejects.toBeInstanceOf(ProviderRetryableError)
    children[0].stdout.emit(
      'data',
      Buffer.from('{"id":2,"result":{"requiresOpenaiAuth":false,"account":null}}\n')
    )
    await expect(provider.readAccount()).resolves.toMatchObject({ signedIn: true })
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(children.map((child) => child.transcript[0]?.method)).toEqual([
      'initialize',
      'initialize'
    ])
  })

  it('shares one clean reconnect across concurrent callers', async () => {
    const { provider, createClient } = createProviderFactorySequence(
      ['timeout-account', 'normal'],
      { requestTimeoutMs: 25 }
    )
    await expect(provider.readAccount()).rejects.toBeInstanceOf(ProviderRetryableError)

    await expect(Promise.all([provider.readAccount(), provider.readAccount()])).resolves.toHaveLength(2)
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('does not retain a crashed reply thread when the next retry reconnects', async () => {
    const { provider, createClient } = createProviderFactorySequence([
      'crash-active',
      'normal'
    ])
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderRetryableError)

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual(SUCCESSFUL_REPLY)
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('closes a connection that finishes starting after provider disposal', async () => {
    const child = new FakeCodexTransport()
    const client = new CodexJsonRpcClient(child)
    await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const createClient = vi.fn(async () => {
      await gate
      return client
    })
    const provider = new CodexProvider({
      createClient,
      openExternal: async () => undefined
    })
    providers.push(provider)

    const account = provider.readAccount()
    await waitUntil(() => createClient.mock.calls.length === 1)
    const disposing = provider.dispose()
    release()

    await expect(account).rejects.toBeInstanceOf(ProviderNonRetryableError)
    await disposing
    expect(child.exitCode).toBe(0)
  })

  it('handles a duplicate matching completion idempotently', async () => {
    const { provider } = await createProvider('duplicate-completion')
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual(SUCCESSFUL_REPLY)
  })

  it('ignores out-of-order completion for another turn', async () => {
    const { provider } = await createProvider('out-of-order')
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual(SUCCESSFUL_REPLY)
  })

  it('interrupts the exact active thread and turn once when aborted', async () => {
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    const controller = new AbortController()
    const iterator = provider.streamReply(request(), controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/start'))
    controller.abort(new DOMException('Stopped', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/interrupt'))

    const messages = transcript
    expect(messages.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    ])
  })

  it('does not interrupt a turn that passed safety completion before the consumer stops', async () => {
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(transcript.filter(({ method }) => method === 'turn/interrupt')).toEqual([])
  })

  it('rejects every active stream while disposing process resources', async () => {
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()
    const pending = iterator.next()
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/start'))

    await provider.dispose()
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        () => 'rejected'
      ),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])

    expect(outcome).toBe('rejected')
  })

  it('allows at most one starting or active turn for each role', async () => {
    const { provider } = await createProvider()
    await provider.discover(role())
    const firstController = new AbortController()
    const first = provider
      .streamReply(request(), firstController.signal)
      [Symbol.asyncIterator]()
    const second = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()

    const firstChunk = first.next()
    await expect(second.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
    await expect(firstChunk).resolves.toMatchObject({ done: false })
    firstController.abort(new DOMException('Stopped', 'AbortError'))
    await first.return?.()
  })

  it('does not create a cwd when already aborted', async () => {
    const createEmptyCwd = vi.fn(async () => '/must-not-be-created')
    const { provider } = await createProvider(
      'normal',
      {},
      vi.fn(async () => undefined),
      { createEmptyCwd }
    )
    await provider.discover(role())
    const controller = new AbortController()
    controller.abort(new DOMException('Stopped', 'AbortError'))

    await expect(collect(provider.streamReply(request(), controller.signal))).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(createEmptyCwd).not.toHaveBeenCalled()
  })

  it('stops after an aborted cwd preparation and cleans the newly created directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ai-debates-abort-cwd-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const removeEmptyCwd = vi.fn(async (path: string) =>
      rm(path, { recursive: true, force: true })
    )
    const { provider, transcript } = await createProvider(
      'normal',
      {},
      vi.fn(async () => undefined),
      {
        createEmptyCwd: async () => {
          await gate
          return cwd
        },
        removeEmptyCwd
      }
    )
    await provider.discover(role())
    const controller = new AbortController()
    const outcome = collect(provider.streamReply(request(), controller.signal))
    await Promise.resolve()
    controller.abort(new DOMException('Stopped', 'AbortError'))
    release()

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    expect(transcript.some(({ method }) => method === 'thread/start')).toBe(false)
    expect(removeEmptyCwd).toHaveBeenCalledWith(cwd)
    await expect(access(cwd)).rejects.toThrow()
  })

  it('stops between thread preparation and turn/start when aborted', async () => {
    const { provider, transcript } = await createProvider('delayed-thread-start')
    await provider.discover(role())
    const controller = new AbortController()
    const outcome = collect(provider.streamReply(request(), controller.signal))
    await waitUntil(() => transcript.some(({ method }) => method === 'thread/start'))
    controller.abort(new DOMException('Stopped', 'AbortError'))

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    expect(transcript.some(({ method }) => method === 'turn/start')).toBe(false)
  })

  it('interrupts an exact turn accepted after abort and yields no content', async () => {
    const { provider, transcript } = await createProvider('delayed-turn-start')
    await provider.discover(role())
    const controller = new AbortController()
    const outcome = collect(provider.streamReply(request(), controller.signal))
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/start'))
    controller.abort(new DOMException('Stopped', 'AbortError'))

    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' })
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/interrupt'))
    expect(transcript.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    ])
  })

  it('cancelActive covers a turn whose turn/start response is still pending', async () => {
    const { provider, transcript } = await createProvider('delayed-turn-start')
    await provider.discover(role())
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()
    const outcome = iterator.next()
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/start'))
    await provider.cancelActive()

    await expect(outcome).rejects.toBeInstanceOf(Error)
    await waitUntil(() => transcript.some(({ method }) => method === 'turn/interrupt'))
    expect(transcript.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    ])
  })
})
