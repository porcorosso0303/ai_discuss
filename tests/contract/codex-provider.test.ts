import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CodexJsonRpcClient } from '../../src/main/providers/codex/jsonrpc-client'
import { CodexProvider } from '../../src/main/providers/codex/codex-provider'
import { ProviderNonRetryableError } from '../../src/main/providers/provider'
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
  openExternal = vi.fn(async () => undefined)
): Promise<{
  provider: CodexProvider
  client: CodexJsonRpcClient
  transcript: Array<Record<string, any>>
  openExternal: typeof openExternal
}> => {
  const child = new FakeCodexTransport({
    mode,
    authUrl: extraEnv.FAKE_AUTH_URL,
    secret: extraEnv.FAKE_SECRET
  })
  const client = new CodexJsonRpcClient(child)
  await client.initialize({ name: 'ai_debates', title: 'AI Debates', version: '0.1.0' })
  const provider = new CodexProvider({
    client,
    openExternal,
    createEmptyCwd: async (roleId) => mkdtemp(join(tmpdir(), `ai-debates-${roleId}-`)),
    removeEmptyCwd: async () => undefined
  })
  providers.push(provider)
  return { provider, client, transcript: child.transcript, openExternal }
}

const collect = async (iterable: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const chunks: ProviderChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
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
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    await provider.discover(role({ roleId: 'role-b' }))

    const chunksA = await collect(provider.streamReply(request(), new AbortController().signal))
    const chunksB = await collect(
      provider.streamReply(request(role({ roleId: 'role-b' })), new AbortController().signal)
    )

    expect(chunksA).toEqual([
      { type: 'content', content: '{"speech":"回应",' },
      { type: 'content', content: '"status":"continue"}' },
      { type: 'final', finishReason: 'stop' }
    ])
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
        sandbox: 'read-only',
        ephemeral: true,
        serviceName: 'ai_debates'
      })
    }
    const turns = messages.filter(({ method }) => method === 'turn/start')
    for (const { params } of turns) {
      expect(params).toMatchObject({
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: 'gpt-test',
        effort: 'high'
      })
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

  it('handles a duplicate matching completion idempotently', async () => {
    const { provider } = await createProvider('duplicate-completion')
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([
      { type: 'content', content: '{"speech":"回应",' },
      { type: 'content', content: '"status":"continue"}' },
      { type: 'final', finishReason: 'stop' }
    ])
  })

  it('ignores out-of-order completion for another turn', async () => {
    const { provider } = await createProvider('out-of-order')
    await provider.discover(role())
    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([
      { type: 'content', content: '{"speech":"回应",' },
      { type: 'content', content: '"status":"continue"}' },
      { type: 'final', finishReason: 'stop' }
    ])
  })

  it('interrupts the exact active thread and turn once when aborted', async () => {
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    const controller = new AbortController()
    const iterator = provider.streamReply(request(), controller.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.value).toEqual({ type: 'content', content: '{"speech":"回应",' })
    controller.abort(new DOMException('Stopped', 'AbortError'))
    await iterator.return?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const messages = transcript
    expect(messages.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    ])
  })

  it('interrupts a turn when its stream consumer stops early', async () => {
    const { provider, transcript } = await createProvider()
    await provider.discover(role())
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(transcript.filter(({ method }) => method === 'turn/interrupt')).toEqual([
      expect.objectContaining({ params: { threadId: 'thread-1', turnId: 'turn-1' } })
    ])
  })

  it('rejects every active stream while disposing process resources', async () => {
    const { provider } = await createProvider()
    await provider.discover(role())
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()
    await iterator.next()

    await provider.dispose()
    const outcome = await Promise.race([
      iterator.next().then(
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
})
