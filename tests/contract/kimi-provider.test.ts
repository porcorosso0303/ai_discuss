import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { KimiProvider } from '../../src/main/providers/kimi/kimi-provider'
import {
  ProviderNonRetryableError,
  ProviderRetryableError
} from '../../src/main/providers/provider'
import type { KimiRoleConfig } from '../../src/shared/domain'
import type { ProviderChunk, ProviderReplyRequest } from '../../src/main/providers/provider'

const modelFixture = JSON.parse(
  readFileSync(new URL('../fixtures/kimi/models.json', import.meta.url), 'utf8')
) as { object: 'list'; data: Array<Record<string, unknown>> }
const chatFixture = JSON.parse(
  readFileSync(new URL('../fixtures/kimi/chat-stream.json', import.meta.url), 'utf8')
) as unknown[]

const secret = 'moonshot-contract-secret'

const role = (overrides: Partial<KimiRoleConfig> = {}): KimiRoleConfig => ({
  roleId: 'role-a',
  name: '甲方',
  personaOrStance: '支持创新',
  provider: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'kimi-k3',
  effort: 'high',
  maxCompletionTokens: 4096,
  ...overrides
})

const request = (config: KimiRoleConfig = role()): ProviderReplyRequest => ({
  sessionId: 'session-contract',
  turn: 3,
  role: config,
  view: {
    system: 'SYSTEM CONTRACT',
    messages: [
      { role: 'assistant', content: '先前观点' },
      { role: 'user', content: '对方反驳' }
    ],
    waiting: false
  }
})

const sseResponse = (events: unknown[]): Response => {
  const completedEvents = events.length === 0
    ? [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
    : events
  return new Response(
    `${completedEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
  )
}

const collect = async (iterable: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const chunks: ProviderChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('KimiProvider model discovery', () => {
  it('uses Bearer auth at the complete base path and maps current model capabilities', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(modelFixture)
    )
    const getApiKey = vi.fn(async () => secret)
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey })

    const capabilities = await provider.discover(role())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.moonshot.cn/v1/models')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({ Authorization: `Bearer ${secret}` })
    expect(capabilities).toEqual({
      provider: 'kimi',
      defaultModel: 'kimi-k3',
      models: [
        {
          id: 'kimi-k3',
          contextLength: 1048576,
          reasoningEfforts: ['low', 'high', 'max'],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-schema', 'json-object']
        },
        {
          id: 'kimi-k2.6',
          contextLength: 262144,
          reasoningEfforts: [],
          thinking: { default: true, keepSupported: true },
          samplingParameters: [],
          structuredOutputModes: ['json-schema', 'json-object']
        },
        {
          id: 'moonshot-v1-32k',
          contextLength: 32768,
          reasoningEfforts: [],
          thinking: null,
          samplingParameters: [
            { name: 'temperature', min: 0, max: 1 },
            { name: 'topP', min: 0, max: 1 },
            { name: 'frequencyPenalty', min: -2, max: 2 },
            { name: 'presencePenalty', min: -2, max: 2 }
          ],
          structuredOutputModes: ['json-schema', 'json-object']
        }
      ]
    })
    expect(JSON.stringify(capabilities)).not.toContain('future_field')
    expect(JSON.stringify(capabilities)).not.toContain(secret)
  })

  it('preserves a custom base path and selects the first model if the configured model is absent', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ object: 'list', data: [modelFixture['data'][1]] })
    )
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    const capabilities = await provider.discover(
      role({ baseUrl: 'https://gateway.example.test/kimi/v1/' })
    )

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://gateway.example.test/kimi/v1/models')
    expect(capabilities.defaultModel).toBe('kimi-k2.6')
  })

  it('trusts a discovered supports_reasoning false flag over a known model name', async () => {
    const provider = new KimiProvider({
      fetch: async () =>
        Response.json({
          object: 'list',
          data: [
            {
              id: 'kimi-k2.6',
              context_length: 262144,
              supports_reasoning: false
            }
          ]
        }),
      getApiKey: async () => secret
    })

    const capabilities = await provider.discover(
      role({ model: 'kimi-k2.6', effort: undefined, thinking: undefined })
    )

    expect(capabilities.models[0]).toMatchObject({
      reasoningEfforts: [],
      thinking: null
    })
  })

  it('isolates discovered capabilities between roles sharing an endpoint and model', async () => {
    const shared = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'custom-shared-model',
      effort: undefined,
      thinking: undefined
    })
    const roleB = { ...shared, roleId: 'role-b' as const }
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>).Authorization
      return Response.json({
        object: 'list',
        data: [
          {
            id: shared.model,
            context_length: 64_000,
            supports_reasoning: authorization === 'Bearer key-role-b'
          }
        ]
      })
    })
    const provider = new KimiProvider({
      fetch: fetchImpl,
      getApiKey: async (config) => `key-${config.roleId}`
    })

    await provider.discover(shared)
    await provider.discover(roleB)

    await expect(
      collect(
        provider.streamReply(
          request({ ...shared, thinking: true }),
          new AbortController().signal
        )
      )
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['https://api.moonshot.cn/v1', 401, ProviderNonRetryableError],
    ['https://api.moonshot.ai/v1/', 503, ProviderRetryableError],
    ['https://api.moonshot.cn./v1', 401, ProviderNonRetryableError],
    ['https://api.moonshot.ai./v1/', 401, ProviderNonRetryableError]
  ] as const)(
    'propagates a safe typed discovery failure from official base %s',
    async (baseUrl, status, ErrorType) => {
      const provider = new KimiProvider({
        fetch: async () =>
          new Response(`Authorization: Bearer ${secret}\nprivate upstream details`, { status }),
        getApiKey: async () => secret
      })

      const error = await provider.discover(role({ baseUrl })).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(ErrorType)
      expect(JSON.stringify(error)).not.toContain(secret)
      expect((error as Error).message).not.toContain('private upstream details')
    }
  )

  it('falls back to the configured model only when a custom compatible base cannot discover', async () => {
    const provider = new KimiProvider({
      fetch: async () => new Response('not available', { status: 404 }),
      getApiKey: async () => secret
    })

    await expect(
      provider.discover(
        role({ baseUrl: 'https://gateway.example.test/openai-compatible/v1' })
      )
    ).resolves.toEqual({
      provider: 'kimi',
      defaultModel: 'kimi-k3',
      models: [
        {
          id: 'kimi-k3',
          reasoningEfforts: ['low', 'high', 'max'],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-schema', 'json-object']
        }
      ]
    })
  })

  it('enforces a custom fallback non-reasoning capability before chat fetch', async () => {
    const config = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'custom-chat-model',
      effort: undefined,
      thinking: true
    })
    const fetchImpl = vi.fn(async () => new Response('models unavailable', { status: 404 }))
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await expect(provider.discover(config)).resolves.toMatchObject({
      models: [{ id: 'custom-chat-model', thinking: null }]
    })
    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('allows a custom fallback model without reasoning controls to chat', async () => {
    const config = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'custom-chat-model',
      effort: undefined,
      thinking: undefined
    })
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      fetchImpl.mock.calls.length === 1
        ? new Response('models unavailable', { status: 404 })
        : sseResponse([])
    )
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await provider.discover(config)
    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).resolves.toEqual([{ type: 'final', finishReason: 'stop' }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      'https://gateway.example.test/v1/chat/completions'
    )
  })

  it('never converts cancellation into custom endpoint fallback', async () => {
    const reason = new DOMException('user cancelled', 'AbortError')
    const provider = new KimiProvider({
      fetch: async () => {
        throw reason
      },
      getApiKey: async () => secret
    })

    await expect(
      provider.discover(role({ baseUrl: 'https://gateway.example.test/v1' }))
    ).rejects.toBe(reason)
  })

  it('turns malformed official discovery data into a safe non-retryable error', async () => {
    const provider = new KimiProvider({
      fetch: async () => Response.json({ object: 'list', data: [{ id: secret }] }),
      getApiKey: async () => secret
    })

    const error = await provider.discover(role()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderNonRetryableError)
    expect((error as Error).message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('validates the provider config before reading a secret or fetching', async () => {
    const fetchImpl = vi.fn(async () => Response.json(modelFixture))
    const getApiKey = vi.fn(async () => secret)
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey })

    await expect(
      provider.discover({
        roleId: 'role-a',
        name: '甲方',
        personaOrStance: '',
        provider: 'openai',
        model: 'gpt-5',
        effort: 'high'
      })
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(getApiKey).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('KimiProvider chat completions', () => {
  it('accepts official nullable usage and a final empty-choices usage chunk', async () => {
    const provider = new KimiProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [
              { index: 0, delta: { content: '{"speech":"ok"' }, finish_reason: null }
            ],
            usage: null
          },
          {
            choices: [
              {
                index: 0,
                delta: { content: ',"status":"continue"}' },
                finish_reason: 'stop'
              }
            ],
            usage: null
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 7,
              total_tokens: 18,
              cached_tokens: 3
            }
          }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([
      { type: 'content', content: '{"speech":"ok"' },
      { type: 'content', content: ',"status":"continue"}' },
      { type: 'final', finishReason: 'stop' },
      {
        type: 'usage',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cacheReadTokens: 3 }
      }
    ])
  })

  it('sends the current K3 strict streaming contract and exposes content but never reasoning', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      sseResponse(chatFixture)
    )
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })
    const controller = new AbortController()

    const chunks = await collect(provider.streamReply(request(), controller.signal))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions')
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      signal: controller.signal
    })
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      model: 'kimi-k3',
      messages: [
        { role: 'system', content: 'SYSTEM CONTRACT' },
        { role: 'assistant', content: '先前观点' },
        { role: 'user', content: '对方反驳' }
      ],
      max_completion_tokens: 4096,
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'debate_reply',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              speech: { type: 'string', minLength: 1, maxLength: 200000 },
              status: { type: 'string', enum: ['continue', 'concede', 'agree'] }
            },
            required: ['speech', 'status'],
            additionalProperties: false
          }
        }
      }
    })
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(chunks).toEqual([
      { type: 'content', content: '{"speech":"有道理，' },
      { type: 'content', content: '但仍需论证。","status":"continue"}' },
      {
        type: 'usage',
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 20 }
      },
      { type: 'final', finishReason: 'stop' }
    ])
    expect(JSON.stringify(chunks)).not.toContain('private chain of thought')
    expect(JSON.stringify(chunks)).not.toContain(secret)
  })

  it.each([
    [
      role({ model: 'kimi-k2.6', effort: undefined, thinking: true, thinkingKeep: 'all' }),
      { type: 'enabled', keep: 'all' }
    ],
    [
      role({ model: 'kimi-k2.6', effort: undefined, thinking: false, thinkingKeep: 'none' }),
      { type: 'disabled' }
    ],
    [role({ model: 'kimi-k2.6', effort: undefined, thinking: undefined, thinkingKeep: undefined }), undefined],
    [role({ model: 'kimi-k2.7-code', effort: undefined, thinking: undefined, thinkingKeep: undefined }), undefined],
    [role({ model: 'kimi-k2.7-code-highspeed', effort: undefined, thinking: true, thinkingKeep: 'all' }), undefined]
  ] as const)('sends only valid fixed K2.x thinking controls', async (config, expectedThinking) => {
    let body: Record<string, unknown> | undefined
    const provider = new KimiProvider({
      fetch: async (_input, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>
        return sseResponse([])
      },
      getApiKey: async () => secret
    })

    await collect(provider.streamReply(request(config), new AbortController().signal))

    if (expectedThinking === undefined) expect(body).not.toHaveProperty('thinking')
    else expect(body?.thinking).toEqual(expectedThinking)
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(body).not.toHaveProperty('presence_penalty')
    expect(body).not.toHaveProperty('frequency_penalty')
  })

  it('maps supported sampling names for an unknown compatible non-reasoning model', async () => {
    let body: Record<string, unknown> | undefined
    const provider = new KimiProvider({
      fetch: async (_input, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>
        return sseResponse([])
      },
      getApiKey: async () => secret
    })
    const config = role({
      model: 'custom-chat-model',
      effort: undefined,
      thinking: false,
      sampling: { temperature: 0.4, topP: 0.8, frequencyPenalty: -0.2, presencePenalty: 0.3 }
    })

    await collect(provider.streamReply(request(config), new AbortController().signal))

    expect(body).toMatchObject({
      thinking: { type: 'disabled' },
      temperature: 0.4,
      top_p: 0.8,
      frequency_penalty: -0.2,
      presence_penalty: 0.3
    })
  })

  it.each([
    role({ model: 'kimi-k3', effort: undefined, thinking: true }),
    role({ model: 'kimi-k2.6', effort: 'high', thinking: true }),
    role({ model: 'kimi-k2.6', effort: undefined, thinking: true, sampling: { temperature: 1 } }),
    role({ model: 'kimi-k2.7-code', effort: undefined, thinking: false }),
    role({ model: 'kimi-k2.7-code', effort: undefined, sampling: { topP: 0.95 } })
  ])('rejects an unsupported Kimi parameter combination before fetch', async (config) => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('enforces a dynamically discovered non-reasoning capability before chat fetch', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls += 1
      return Response.json({
        object: 'list',
        data: [
          {
            id: 'custom-chat-model',
            context_length: 64000,
            supports_reasoning: false
          }
        ]
      })
    })
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => secret })
    const discoveryConfig = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'custom-chat-model',
      effort: undefined,
      thinking: false
    })
    await provider.discover(discoveryConfig)

    await expect(
      collect(
        provider.streamReply(
          request({ ...discoveryConfig, thinking: true }),
          new AbortController().signal
        )
      )
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(calls).toBe(1)
  })

  it('rejects preserved thinking when discovery cannot establish keep support', async () => {
    let calls = 0
    const config = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'custom-reasoning-model',
      effort: undefined,
      thinking: true,
      thinkingKeep: 'all'
    })
    const provider = new KimiProvider({
      fetch: async () => {
        calls += 1
        return Response.json({
          object: 'list',
          data: [
            {
              id: config.model,
              context_length: 64000,
              supports_reasoning: true
            }
          ]
        })
      },
      getApiKey: async () => secret
    })
    await provider.discover(config)

    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(calls).toBe(1)
  })

  it.each([
    ['length', 'length'],
    ['content_filter', 'refusal'],
    ['refusal', 'refusal']
  ] as const)('maps Kimi finish reason %s', async (upstream, expected) => {
    const provider = new KimiProvider({
      fetch: async () =>
        sseResponse([
          { choices: [{ index: 0, delta: {}, finish_reason: upstream }] }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([{ type: 'final', finishReason: expected }])
  })

  it.each([
    [
      'multiple choices',
      [
        { index: 0, delta: {}, finish_reason: 'stop' },
        { index: 0, delta: {}, finish_reason: 'stop' }
      ]
    ],
    ['a nonzero choice index', [{ index: 1, delta: {}, finish_reason: 'stop' }]]
  ])('rejects %s before yielding provider chunks', async (_shape, choices) => {
    const provider = new KimiProvider({
      fetch: async () => sseResponse([{ choices }]),
      getApiKey: async () => secret
    })
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it.each([
    [
      'a repeated finish',
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ],
    [
      'content after finish',
      {
        choices: [
          { index: 0, delta: { content: 'late upstream content' }, finish_reason: null }
        ]
      }
    ]
  ])('rejects %s without yielding it', async (_shape, trailingEvent) => {
    const provider = new KimiProvider({
      fetch: async () =>
        sseResponse([
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          trailingEvent
        ]),
      getApiKey: async () => secret
    })
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'final', finishReason: 'stop' }
    })
    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it('rejects an unknown finish reason', async () => {
    const provider = new KimiProvider({
      fetch: async () =>
        sseResponse([
          { choices: [{ index: 0, delta: {}, finish_reason: 'future_reason' }] }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it.each([
    [
      'content EOF',
      `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: { content: '{"speech":"partial' }, finish_reason: null }
        ]
      })}\n\n`
    ],
    ['empty EOF', '']
  ])('rejects a truncated Kimi stream at %s as retryable', async (_shape, body) => {
    const provider = new KimiProvider({
      fetch: async () => new Response(body),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderRetryableError)
  })

  it('allows the exact visible-content budget and does not count reasoning', async () => {
    const visibleContent = 'v'.repeat(201_000)
    const provider = new KimiProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { reasoning_content: 'private'.repeat(35_715) },
                finish_reason: null
              }
            ]
          },
          {
            choices: [
              { index: 0, delta: { content: visibleContent }, finish_reason: null }
            ]
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
        ]),
      getApiKey: async () => secret
    })

    let visibleLength = 0
    let finalCount = 0
    for await (const chunk of provider.streamReply(request(), new AbortController().signal)) {
      if (chunk.type === 'content') visibleLength += chunk.content.length
      if (chunk.type === 'final') finalCount += 1
    }

    expect(visibleLength).toBe(201_000)
    expect(finalCount).toBe(1)
  })

  it('rejects cumulative visible content before yielding the chunk that crosses the budget', async () => {
    const events: unknown[] = Array.from({ length: 202 }, () => ({
      choices: [{ index: 0, delta: { content: 'v'.repeat(1_000) }, finish_reason: null }]
    }))
    events.push({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })
    const provider = new KimiProvider({
      fetch: async () => sseResponse(events),
      getApiKey: async () => secret
    })
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()

    for (let index = 0; index < 201; index += 1) {
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'content' }
      })
    }
    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it.each([
    [`not-json ${secret}`, 'malformed JSON'],
    [
      JSON.stringify({
        choices: [{ index: 0, delta: { content: 42 }, finish_reason: null }],
        ignored_secret: secret
      }),
      'invalid shape'
    ]
  ])('turns %s SSE into a safe non-retryable error', async (privateResponse) => {
    const provider = new KimiProvider({
      fetch: async () => new Response(`data: ${privateResponse}\n\ndata: [DONE]\n\n`),
      getApiKey: async () => secret
    })

    const error = await collect(
      provider.streamReply(request(), new AbortController().signal)
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderNonRetryableError)
    expect((error as Error).message).not.toContain(secret)
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it.each([
    [429, ProviderRetryableError],
    [503, ProviderRetryableError],
    [400, ProviderNonRetryableError],
    [401, ProviderNonRetryableError]
  ] as const)('maps chat HTTP %s without exposing the response or secret', async (status, ErrorType) => {
    const provider = new KimiProvider({
      fetch: async () =>
        new Response(`Authorization: Bearer ${secret}\nprivate request failure`, { status }),
      getApiKey: async () => secret
    })

    const error = await collect(
      provider.streamReply(request(), new AbortController().signal)
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ErrorType)
    expect((error as Error).message).not.toContain('private request failure')
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('preserves the exact abort reason through streaming', async () => {
    const reason = new DOMException('user cancelled', 'AbortError')
    const provider = new KimiProvider({
      fetch: async () => {
        throw reason
      },
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBe(reason)
  })

  it('rejects an empty API key before sending a request', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const provider = new KimiProvider({ fetch: fetchImpl, getApiKey: async () => '  ' })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
