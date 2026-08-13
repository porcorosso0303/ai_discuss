import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  DEEPSEEK_CAPABILITIES_DOCUMENT_DATE,
  DEEPSEEK_CAPABILITIES_SOURCE_URL,
  DEEPSEEK_CHAT_CONTRACT_SOURCE_URL
} from '../../src/main/providers/deepseek/deepseek-capabilities'
import { DeepSeekProvider } from '../../src/main/providers/deepseek/deepseek-provider'
import {
  ProviderNonRetryableError,
  ProviderRetryableError,
  type ProviderChunk,
  type ProviderReplyRequest
} from '../../src/main/providers/provider'
import type { DeepSeekRoleConfig, KimiRoleConfig } from '../../src/shared/domain'

const modelsFixture = JSON.parse(
  readFileSync(new URL('../fixtures/deepseek/models.json', import.meta.url), 'utf8')
) as { object: 'list'; data: Array<Record<string, unknown>> }
const chatFixture = JSON.parse(
  readFileSync(new URL('../fixtures/deepseek/chat-stream.json', import.meta.url), 'utf8')
) as unknown[]

const secret = 'deepseek-contract-secret'

const role = (overrides: Partial<DeepSeekRoleConfig> = {}): DeepSeekRoleConfig => ({
  roleId: 'role-a',
  name: '甲方',
  personaOrStance: '支持创新',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  thinking: true,
  effort: 'high',
  maxTokens: 8192,
  ...overrides
})

const request = (config: DeepSeekRoleConfig = role()): ProviderReplyRequest => ({
  sessionId: 'session-contract',
  turn: 3,
  role: config,
  view: {
    system: 'SYSTEM CONTRACT: return JSON with speech and status.',
    messages: [
      { role: 'assistant', content: '先前观点' },
      { role: 'user', content: '对方反驳' }
    ],
    waiting: false
  }
})

const sseResponse = (events: unknown[], includeDone = true): Response =>
  new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}${
      includeDone ? 'data: [DONE]\n\n' : ''
    }`
  )

const collect = async (iterable: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> => {
  const chunks: ProviderChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

describe('DeepSeekProvider model discovery', () => {
  it('documents and maps the current official V4 capability contract', async () => {
    const fetchImpl = vi.fn(async () => Response.json(modelsFixture))
    const provider = new DeepSeekProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    const capabilities = await provider.discover(role())

    expect(DEEPSEEK_CAPABILITIES_DOCUMENT_DATE).toBe('2026-08-13')
    expect(DEEPSEEK_CAPABILITIES_SOURCE_URL).toBe(
      'https://api-docs.deepseek.com/quick_start/pricing/'
    )
    expect(DEEPSEEK_CHAT_CONTRACT_SOURCE_URL).toBe(
      'https://api-docs.deepseek.com/api/create-chat-completion/'
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/models')
    expect(init).toMatchObject({
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}` }
    })
    expect(capabilities).toEqual({
      provider: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
      models: [
        {
          id: 'deepseek-v4-flash',
          reasoningEfforts: ['low', 'high', 'max'],
          contextLength: 1_000_000,
          maxOutputTokens: 384_000,
          thinking: { default: true, keepSupported: false },
          samplingParameters: [
            { name: 'temperature', min: 0, max: 2, default: 1 },
            { name: 'topP', min: 0, max: 1, default: 1 }
          ],
          structuredOutputModes: ['json-object']
        },
        {
          id: 'deepseek-v4-pro',
          reasoningEfforts: ['low', 'high', 'max'],
          contextLength: 1_000_000,
          maxOutputTokens: 384_000,
          thinking: { default: true, keepSupported: false },
          samplingParameters: [
            { name: 'temperature', min: 0, max: 2, default: 1 },
            { name: 'topP', min: 0, max: 1, default: 1 }
          ],
          structuredOutputModes: ['json-object']
        },
        {
          id: 'gateway-private-model',
          reasoningEfforts: [],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: []
        }
      ]
    })
    expect(JSON.stringify(capabilities)).not.toContain('future_field')
    expect(JSON.stringify(capabilities)).not.toContain(secret)
  })

  it.each([
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/models'],
    ['https://gateway.example.test/deepseek/v1/', 'https://gateway.example.test/deepseek/v1/models']
  ])('preserves the complete base path %s', async (baseUrl, expectedUrl) => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json(modelsFixture)
    )
    const provider = new DeepSeekProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await provider.discover(role({ baseUrl }))

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(expectedUrl)
  })

  it('selects the first discovered model when the configured model is absent', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () => Response.json({ object: 'list', data: [modelsFixture.data[0]] }),
      getApiKey: async () => secret
    })

    const capabilities = await provider.discover(role())

    expect(capabilities.defaultModel).toBe('deepseek-v4-flash')
  })

  it.each([
    'https://api.deepseek.com/proxy/v1',
    'https://api.deepseek.com./v1'
  ])('fails closed for an official hostname at %s', async (baseUrl) => {
    const provider = new DeepSeekProvider({
      fetch: async () => new Response('private upstream failure', { status: 503 }),
      getApiKey: async () => secret
    })

    await expect(provider.discover(role({ baseUrl }))).rejects.toBeInstanceOf(
      ProviderRetryableError
    )
  })

  it('falls back to only the configured model when custom discovery fails', async () => {
    const config = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'private-model',
      thinking: undefined,
      effort: undefined
    })
    const provider = new DeepSeekProvider({
      fetch: async () => new Response('not implemented', { status: 404 }),
      getApiKey: async () => secret
    })

    await expect(provider.discover(config)).resolves.toEqual({
      provider: 'deepseek',
      defaultModel: 'private-model',
      models: [
        {
          id: 'private-model',
          reasoningEfforts: [],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: []
        }
      ]
    })
  })

  it('preserves an exact abort instead of using custom fallback', async () => {
    const reason = new DOMException('user cancelled', 'AbortError')
    const provider = new DeepSeekProvider({
      fetch: async () => {
        throw reason
      },
      getApiKey: async () => secret
    })

    await expect(
      provider.discover(role({ baseUrl: 'https://gateway.example.test/v1' }))
    ).rejects.toBe(reason)
  })

  it('rejects unbounded or malformed discovery data safely', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        Response.json({
          object: 'list',
          data: Array.from({ length: 201 }, (_, index) => ({
            id: `model-${index}`,
            object: 'model',
            owned_by: 'deepseek'
          }))
        }),
      getApiKey: async () => secret
    })

    const error = await provider.discover(role()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderNonRetryableError)
    expect((error as Error).message).not.toContain(secret)
  })

  it('atomically replaces a bounded role cache and writes custom fallback capabilities', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ object: 'list', data: [modelsFixture.data[0], modelsFixture.data[1]] })
      )
      .mockResolvedValueOnce(Response.json({ object: 'list', data: [modelsFixture.data[1]] }))
      .mockResolvedValueOnce(new Response('not implemented', { status: 404 }))
    const provider = new DeepSeekProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await provider.discover(role({ roleId: 'role-a' }))
    await provider.discover(role({ roleId: 'role-b' }))
    await provider.discover(
      role({
        roleId: 'role-a',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'fallback-model',
        thinking: undefined,
        effort: undefined
      })
    )

    const cache = (
      provider as unknown as {
        discoveredCapabilitiesByRole: Map<string, ReadonlyMap<string, unknown>>
      }
    ).discoveredCapabilitiesByRole
    expect(cache.size).toBe(2)
    expect(cache.get('role-a')?.size).toBe(1)
    expect([...cache.get('role-a')!.keys()][0]).toContain('fallback-model')
    expect(cache.get('role-b')?.size).toBe(1)
    expect([...cache.get('role-b')!.keys()][0]).toContain('deepseek-v4-pro')
  })

  it('normalizes duplicate official models without replacing the last valid role cache', async () => {
    let duplicate = false
    const provider = new DeepSeekProvider({
      fetch: async () =>
        Response.json({
          object: 'list',
          data: duplicate
            ? [modelsFixture.data[0], modelsFixture.data[0]]
            : [modelsFixture.data[1]]
        }),
      getApiKey: async () => secret
    })
    await provider.discover(role())
    const cache = (
      provider as unknown as {
        discoveredCapabilitiesByRole: Map<string, ReadonlyMap<string, unknown>>
      }
    ).discoveredCapabilitiesByRole
    const validRoleCache = cache.get('role-a')
    duplicate = true

    await expect(provider.discover(role())).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )
    expect(cache.get('role-a')).toBe(validRoleCache)
  })
})

describe('DeepSeekProvider chat request', () => {
  it('sends the exact official V4 JSON streaming request without deprecated fields', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const provider = new DeepSeekProvider({
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return sseResponse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: null
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 1
            }
          }
        ])
      },
      getApiKey: async () => secret
    })

    await collect(provider.streamReply(request(), new AbortController().signal))

    expect(capturedUrl).toBe('https://api.deepseek.com/chat/completions')
    expect(capturedInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      }
    })
    const body = JSON.parse(capturedInit?.body as string) as Record<string, unknown>
    expect(body).toEqual({
      model: 'deepseek-v4-pro',
      messages: [
        { role: 'system', content: 'SYSTEM CONTRACT: return JSON with speech and status.' },
        { role: 'assistant', content: '先前观点' },
        { role: 'user', content: '对方反驳' }
      ],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' }
    })
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('json_schema')
    expect(body).not.toHaveProperty('frequency_penalty')
    expect(body).not.toHaveProperty('presence_penalty')
    expect(body).not.toHaveProperty('tools')
  })

  it.each([
    [
      role({ thinking: true, effort: 'low' }),
      { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
    ],
    [
      role({ thinking: undefined, effort: 'max' }),
      { thinking: undefined, reasoning_effort: 'max' }
    ],
    [
      role({ thinking: undefined, effort: undefined }),
      { thinking: undefined, reasoning_effort: undefined }
    ],
    [
      role({
        thinking: false,
        effort: undefined,
        sampling: { temperature: 0.4, topP: 0.8 }
      }),
      {
        thinking: { type: 'disabled' },
        reasoning_effort: undefined,
        temperature: 0.4,
        top_p: 0.8
      }
    ]
  ] as const)('sends only reasoning controls valid for config %#', async (config, expected) => {
    let body: Record<string, unknown> | undefined
    const provider = new DeepSeekProvider({
      fetch: async (_input, init) => {
        body = JSON.parse(init?.body as string) as Record<string, unknown>
        return sseResponse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: null
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
              prompt_cache_hit_tokens: 0,
              prompt_cache_miss_tokens: 1
            }
          }
        ])
      },
      getApiKey: async () => secret
    })

    await collect(provider.streamReply(request(config), new AbortController().signal))

    for (const [key, value] of Object.entries(expected)) {
      if (value === undefined) expect(body).not.toHaveProperty(key)
      else expect(body).toHaveProperty(key, value)
    }
    if (config.thinking !== false) {
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('top_p')
    }
  })

  it.each([
    role({ thinking: true, effort: 'high', sampling: { temperature: 1 } }),
    role({ thinking: false, effort: 'high' }),
    role({ maxTokens: 384_001 })
  ])('rejects an invalid V4 parameter combination before fetch', async (config) => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const provider = new DeepSeekProvider({ fetch: fetchImpl, getApiKey: async () => secret })

    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects reasoning controls for a discovered unknown model before chat fetch', async () => {
    const config = role({
      baseUrl: 'https://gateway.example.test/v1',
      model: 'gateway-private-model',
      thinking: true,
      effort: 'high'
    })
    let calls = 0
    const provider = new DeepSeekProvider({
      fetch: async () => {
        calls += 1
        return Response.json({ object: 'list', data: [modelsFixture.data[2]] })
      },
      getApiKey: async () => secret
    })
    await provider.discover(config)

    await expect(
      collect(provider.streamReply(request(config), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(calls).toBe(1)
  })

  it('rejects an empty key and a non-DeepSeek role before fetch', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const emptyKeyProvider = new DeepSeekProvider({
      fetch: fetchImpl,
      getApiKey: async () => '  '
    })

    await expect(
      collect(emptyKeyProvider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)

    const kimiRole: KimiRoleConfig = {
      roleId: 'role-a',
      name: '甲方',
      personaOrStance: '',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      maxCompletionTokens: 100
    }
    await expect(
      collect(
        emptyKeyProvider.streamReply(
          { ...request(), role: kimiRole },
          new AbortController().signal
        )
      )
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not expose a secret-bearing credential-store error', async () => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const provider = new DeepSeekProvider({
      fetch: fetchImpl,
      getApiKey: async () => {
        throw new ProviderNonRetryableError(`credential failed for ${secret}`)
      }
    })

    const error = await collect(
      provider.streamReply(request(), new AbortController().signal)
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderNonRetryableError)
    expect((error as Error).message).not.toContain(secret)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('observes cancellation while the credential read is still pending', async () => {
    let releaseCredential!: (value: string) => void
    const credential = new Promise<string>((resolve) => {
      releaseCredential = resolve
    })
    const fetchImpl = vi.fn(async () => sseResponse([]))
    const provider = new DeepSeekProvider({
      fetch: fetchImpl,
      getApiKey: async () => credential
    })
    const controller = new AbortController()
    const reason = new DOMException('cancel credential wait', 'AbortError')
    const pending = collect(provider.streamReply(request(), controller.signal))
    const assertion = expect(pending).rejects.toBe(reason)

    controller.abort(reason)

    await assertion
    expect(fetchImpl).not.toHaveBeenCalled()
    releaseCredential(secret)
  })
})

describe('DeepSeekProvider streaming response', () => {
  it('yields visible content and non-null root usage while hiding nullable reasoning', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () => sseResponse(chatFixture),
      getApiKey: async () => secret
    })

    const chunks = await collect(
      provider.streamReply(request(), new AbortController().signal)
    )

    expect(chunks).toEqual([
      { type: 'content', content: '{"speech":"有道理，' },
      { type: 'content', content: '但仍需论证。","status":"continue"}' },
      { type: 'final', finishReason: 'stop' },
      {
        type: 'usage',
        usage: {
          inputTokens: 120,
          outputTokens: 38,
          totalTokens: 158,
          cacheReadTokens: 20,
          reasoningTokens: 8
        }
      }
    ])
    expect(JSON.stringify(chunks)).not.toContain('private chain of thought')
    expect(JSON.stringify(chunks)).not.toContain(secret)
  })

  it.each([
    ['length', 'length'],
    ['content_filter', 'refusal']
  ] as const)('maps DeepSeek finish reason %s', async (upstream, expected) => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: upstream }],
            usage: null
          }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([{ type: 'final', finishReason: expected }])
  })

  it('accepts the official final-delta example where role is null', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { role: null, content: '' },
                finish_reason: 'stop'
              }
            ],
            usage: null
          }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).resolves.toEqual([{ type: 'final', finishReason: 'stop' }])
  })

  it('maps insufficient system resources to a retryable error', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [
              { index: 0, delta: {}, finish_reason: 'insufficient_system_resource' }
            ],
            usage: null
          }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderRetryableError)
  })

  it('rejects tool_calls because the debate adapter never sends tools', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: null
          }
        ]),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
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
    const provider = new DeepSeekProvider({
      fetch: async () => sseResponse([{ choices, usage: null }]),
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
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }
    ],
    [
      'content after finish',
      {
        choices: [
          { index: 0, delta: { content: 'late content' }, finish_reason: null }
        ],
        usage: null
      }
    ],
    ['an empty non-usage chunk after finish', { choices: [], usage: null }]
  ])('rejects %s without yielding it', async (_shape, trailingEvent) => {
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: null
          },
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

  it.each([
    [
      'usage before finish',
      [
        {
          choices: [],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1
          }
        }
      ]
    ],
    [
      'duplicate usage',
      [
        {
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: null
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1
          }
        },
        {
          choices: [],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 1
          }
        }
      ]
    ]
  ])('rejects %s', async (_shape, events) => {
    const provider = new DeepSeekProvider({
      fetch: async () => sseResponse(events),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it.each([
    [
      'empty choices with null usage before finish',
      { choices: [], usage: null }
    ],
    [
      'nonnull usage alongside a choice',
      {
        choices: [{ index: 0, delta: { content: 'must-not-yield' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 1
        }
      }
    ]
  ])('rejects %s before yielding any chunk', async (_shape, event) => {
    const provider = new DeepSeekProvider({
      fetch: async () => sseResponse([event]),
      getApiKey: async () => secret
    })
    const iterator = provider
      .streamReply(request(), new AbortController().signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderNonRetryableError)
  })

  it.each([
    [
      'content EOF',
      [
        {
          choices: [
            {
              index: 0,
              delta: { content: '{"speech":"partial' },
              finish_reason: null
            }
          ],
          usage: null
        }
      ]
    ],
    ['empty EOF', []]
  ])('rejects a truncated stream at %s as retryable', async (_shape, events) => {
    const provider = new DeepSeekProvider({
      fetch: async () => sseResponse(events, false),
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBeInstanceOf(ProviderRetryableError)
  })

  it('allows the exact visible-content budget without counting private reasoning', async () => {
    const visibleContent = 'v'.repeat(201_000)
    const provider = new DeepSeekProvider({
      fetch: async () =>
        sseResponse([
          {
            choices: [
              {
                index: 0,
                delta: { reasoning_content: 'private'.repeat(35_715), content: null },
                finish_reason: null
              }
            ],
            usage: null
          },
          {
            choices: [
              { index: 0, delta: { content: visibleContent }, finish_reason: null }
            ],
            usage: null
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: null
          }
        ]),
      getApiKey: async () => secret
    })

    let visibleLength = 0
    for await (const chunk of provider.streamReply(request(), new AbortController().signal)) {
      if (chunk.type === 'content') visibleLength += chunk.content.length
    }

    expect(visibleLength).toBe(201_000)
  })

  it('rejects cumulative visible overflow before yielding the crossing chunk', async () => {
    const events: unknown[] = Array.from({ length: 202 }, () => ({
      choices: [
        { index: 0, delta: { content: 'v'.repeat(1_000) }, finish_reason: null }
      ],
      usage: null
    }))
    events.push({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: null
    })
    const provider = new DeepSeekProvider({
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
        usage: null,
        ignored_secret: secret
      }),
      'invalid shape'
    ],
    [
      JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: 'future_reason' }],
        usage: null
      }),
      'unknown finish'
    ]
  ])('turns %s into a safe non-retryable error', async (privateResponse) => {
    const provider = new DeepSeekProvider({
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
  ] as const)('maps chat HTTP %s without exposing response data', async (status, ErrorType) => {
    const provider = new DeepSeekProvider({
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

  it('maps a network failure without retaining a secret-bearing cause', async () => {
    const provider = new DeepSeekProvider({
      fetch: async () => {
        throw new Error(`socket failed with ${secret}`)
      },
      getApiKey: async () => secret
    })

    const error = await collect(
      provider.streamReply(request(), new AbortController().signal)
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderRetryableError)
    expect((error as Error).cause).toBeUndefined()
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  it('preserves the exact abort reason through streaming', async () => {
    const reason = new DOMException('user cancelled', 'AbortError')
    const provider = new DeepSeekProvider({
      fetch: async () => {
        throw reason
      },
      getApiKey: async () => secret
    })

    await expect(
      collect(provider.streamReply(request(), new AbortController().signal))
    ).rejects.toBe(reason)
  })
})
