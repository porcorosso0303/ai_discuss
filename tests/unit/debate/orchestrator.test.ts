import { describe, expect, it } from 'vitest'

import { DebateOrchestrator } from '../../../src/main/debate/orchestrator'
import {
  ProviderNonRetryableError,
  ProviderRefusalError,
  ProviderRetryableError,
  type Provider
} from '../../../src/main/providers/provider'
import type { DebateSetup } from '../../../src/shared/domain'
import { debateEventSchema } from '../../../src/shared/schemas'
import {
  DeferredDebateRepository,
  FakeDebateRepository,
  FakeProvider,
  FirstSaveDeferredRepository,
  FirstSaveRejectingRepository,
  deterministicDependencies
} from '../../helpers/fake-provider'

const setup = (maxTurns = 2): DebateSetup => ({
  topic: '人工智能应否进入课堂？',
  roles: [
    {
      roleId: 'role-a',
      name: '甲方',
      personaOrStance: '支持',
      provider: 'openai',
      model: 'gpt-5',
      effort: 'high'
    },
    {
      roleId: 'role-b',
      name: '乙方',
      personaOrStance: '反对',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2.5',
      thinking: false,
      maxCompletionTokens: 2048
    }
  ],
  firstSpeaker: 'role-a',
  maxTurns
})

const jsonReply = (speech: string, status = 'continue'): string =>
  JSON.stringify({ speech, status })

const acceptsProviderContract = (_provider: Provider): void => undefined

describe('DebateOrchestrator turn scheduling', () => {
  it('passes the startup abort signal through every role validation', async () => {
    const signals: Array<AbortSignal | undefined> = []
    const openai = new FakeProvider([])
    const kimi = new FakeProvider([])
    const originalOpenAIDiscover = openai.discover.bind(openai)
    const originalKimiDiscover = kimi.discover.bind(kimi)
    openai.discover = async (role, signal) => {
      signals.push(signal)
      return await originalOpenAIDiscover(role, signal)
    }
    kimi.discover = async (role, signal) => {
      signals.push(signal)
      return await originalKimiDiscover(role, signal)
    }
    const controller = new AbortController()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    await orchestrator.start(setup(1), controller.signal)
    expect(signals).toEqual([controller.signal, controller.signal])
  })

  it('calls the configured first speaker and then strictly alternates providers', async () => {
    const calls: string[] = []
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('甲方开场') },
          { type: 'final', finishReason: 'stop' }
        ],
        onStart: ({ role }) => calls.push(role.roleId)
      }
    ])
    const kimi = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('乙方回应') },
          { type: 'final', finishReason: 'stop' }
        ],
        onStart: ({ role }) => calls.push(role.roleId)
      }
    ])
    const repository = new FakeDebateRepository()
    acceptsProviderContract(openai)
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository
    })

    const session = await orchestrator.start(setup())

    expect(calls).toEqual(['role-a', 'role-b'])
    expect(openai.requests).toHaveLength(1)
    expect(openai.requests[0]?.view.waiting).toBe(false)
    expect(kimi.requests).toHaveLength(1)
    expect(kimi.requests[0]?.view.messages.at(-1)?.content).toContain('甲方开场')
    expect(session.messages.map(({ roleId }) => roleId)).toEqual(['role-a', 'role-b'])
    expect(session.currentTurn).toBe(2)
    expect(session.state).toBe('unresolved')
  })

  it('emits strict visible events in order and persists only completed parsed messages', async () => {
    const provider = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: '{"speech":"流式' },
          { type: 'content', content: '正文","status":"continue"}' },
          {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
          },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new FakeDebateRepository()
    const events: unknown[] = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai: provider, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const session = await orchestrator.start(setup(1))

    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      'state-changed',
      'state-changed',
      'turn-started',
      'speech-delta',
      'speech-delta',
      'usage-updated',
      'message-completed',
      'state-changed'
    ])
    for (const event of events) {
      expect(debateEventSchema.parse(event)).toEqual(event)
    }
    const chunks = events.filter(
      (event) => (event as { type: string }).type === 'speech-delta'
    )
    expect(Object.keys(chunks[0] as object).sort()).toEqual([
      'createdAt',
      'delta',
      'id',
      'roleId',
      'sessionId',
      'turn',
      'type'
    ])
    expect(JSON.stringify(events)).not.toContain('reasoning')
    expect(session.messages[0]).toMatchObject({
      speech: '流式正文',
      status: 'continue',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
    })
    expect(repository.saved).not.toHaveLength(0)
    expect(repository.saved.every((saved) => saved.messages.every(({ speech }) => speech !== '')))
      .toBe(true)
    expect(repository.saved.at(-1)?.messages).toEqual(session.messages)
    expect(session.events).not.toHaveLength(0)
    expect(session.events.some(({ type }) => type === 'speech-delta')).toBe(false)
    expect(session.events).toEqual(
      events.filter((event) => (event as { type: string }).type !== 'speech-delta')
    )
    expect(repository.saved.at(-1)?.events).toEqual(session.events)
    expect(JSON.stringify(session.events)).not.toContain('raw')
    expect(JSON.stringify(session.events)).not.toContain('reasoning')
  })

  it('issues exactly 100 provider calls at the configured 100-turn boundary', async () => {
    const replyScript = (turn: number) => ({
      chunks: [
        { type: 'content' as const, content: jsonReply(`第 ${turn} 次发言`) },
        { type: 'final' as const, finishReason: 'stop' as const }
      ]
    })
    const openai = new FakeProvider(
      Array.from({ length: 50 }, (_, index) => replyScript(index * 2 + 1))
    )
    const kimi = new FakeProvider(
      Array.from({ length: 50 }, (_, index) => replyScript(index * 2 + 2))
    )
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    const session = await orchestrator.start(setup(100))

    expect(openai.requests).toHaveLength(50)
    expect(kimi.requests).toHaveLength(50)
    expect(session.currentTurn).toBe(100)
    expect(session.messages).toHaveLength(100)
    expect(session.state).toBe('unresolved')
  })

  it('does not call the opponent after a first-turn concession', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('我认输', 'concede') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const kimi = new FakeProvider([])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    const session = await orchestrator.start(setup(100))

    expect(openai.requests).toHaveLength(1)
    expect(kimi.requests).toHaveLength(0)
    expect(session.state).toBe('completed')
    expect(session.winnerRoleId).toBe('role-b')
  })
})

describe('DebateOrchestrator pause and stop controls', () => {
  it('serializes immutable saves so an older running snapshot cannot overwrite stopped', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('甲方已完成') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new FirstSaveDeferredRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository
    })

    const starting = orchestrator.start(setup(2))
    await repository.waitForFirstSave()
    expect(repository.started[0]?.state).toBe('running')

    const stopping = orchestrator.stop()
    await Promise.resolve()
    repository.releaseFirst()
    await Promise.all([starting, stopping])

    expect(repository.maxConcurrentSaves).toBe(1)
    expect(orchestrator.getSession().state).toBe('stopped')
    expect(repository.saved.at(-1)?.state).toBe('stopped')
    expect(repository.saved.at(-1)).toEqual(orchestrator.getSession())
  })

  it('continues the save queue after one repository write rejects', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('触发首次保存失败') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new FirstSaveRejectingRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository
    })

    await expect(orchestrator.start(setup(2))).rejects.toThrow('simulated repository failure')
    const stopped = await orchestrator.stop()

    expect(stopped.state).toBe('stopped')
    expect(repository.calls).toBe(2)
    expect(repository.saved.at(-1)?.state).toBe('stopped')
  })

  it('shares one drive while pause and resume race with a completed-turn save', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('甲方完成') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const kimi = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('乙方只应调用一次') },
          { type: 'final', finishReason: 'stop' }
        ],
        waitAt: 1
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('乙方重复调用') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new DeferredDebateRepository()
    const events: Array<{ type: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const starting = orchestrator.start(setup(2))
    await repository.waitForStarted(1)
    const pausing = orchestrator.pause()
    expect(orchestrator.getSession().state).toBe('paused')
    const resuming = orchestrator.resume()

    repository.releaseNext()
    await kimi.waitForCalls(1)
    kimi.releaseCall(0)
    await repository.waitForStarted(2)
    repository.releaseNext()
    await repository.waitForStarted(3)
    repository.releaseNext()

    const [started, paused, resumed] = await Promise.all([starting, pausing, resuming])

    expect(started.state).toBe('unresolved')
    expect(paused.state).toBe('paused')
    expect(resumed.state).toBe('unresolved')
    expect(kimi.requests).toHaveLength(1)
    expect(
      events.filter(({ type }) => type === 'message-completed')
    ).toHaveLength(2)
  })

  it('does not start another provider request when resume is called while already running', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('原始请求') },
          { type: 'final', finishReason: 'stop' }
        ],
        waitAt: 1
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('不应发起的重复请求') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    const running = orchestrator.start(setup(1))
    await openai.waitForCalls(1)
    const unchanged = await orchestrator.resume()

    expect(unchanged.state).toBe('running')
    expect(openai.requests).toHaveLength(1)

    openai.releaseCall(0)
    const finished = await running
    expect(finished.messages.map(({ speech }) => speech)).toEqual(['原始请求'])
  })

  it('finishes the active speech before pausing and resumes with the opponent', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('甲方完整发言') },
          { type: 'final', finishReason: 'stop' }
        ],
        waitAt: 1
      }
    ])
    const kimi = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('乙方完整回应') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const events: Array<{ type: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      onEvent: (event) => events.push(event)
    })

    const initialRun = orchestrator.start(setup())
    await openai.waitForCalls(1)
    orchestrator.pause()

    expect(orchestrator.getSession().state).toBe('pausing')
    expect(kimi.requests).toHaveLength(0)

    openai.releaseCall(0)
    const paused = await initialRun

    expect(paused.state).toBe('paused')
    expect(paused.messages.map(({ speech }) => speech)).toEqual(['甲方完整发言'])
    expect(kimi.requests).toHaveLength(0)
    expect(events.map(({ type }) => type)).toContain('message-completed')

    const finished = await orchestrator.resume()
    expect(finished.state).toBe('unresolved')
    expect(finished.messages.map(({ roleId }) => roleId)).toEqual(['role-a', 'role-b'])
  })

  it('aborts an active stream on stop and never persists its partial draft', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: '{"speech":"半条' },
          { type: 'content', content: '不应保存","status":"continue"}' }
        ],
        waitAt: 1
      }
    ])
    const repository = new FakeDebateRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository
    })

    const running = orchestrator.start(setup(2))
    await openai.waitForCalls(1)
    await orchestrator.stop()
    const stopped = await running

    expect(openai.cancelCalls).toBe(1)
    expect(stopped.state).toBe('stopped')
    expect(stopped.currentTurn).toBe(0)
    expect(stopped.messages).toEqual([])
    expect(repository.saved.every(({ messages }) => messages.length === 0)).toBe(true)
  })

  it('ignores chunks and completion arriving after stop even when a provider ignores abort', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: '{"speech":"先到' },
          { type: 'content', content: '的迟到正文","status":"continue"}' },
          { type: 'final', finishReason: 'stop' }
        ],
        waitAt: 1,
        ignoreAbort: true
      }
    ])
    const events: Array<{ type: string }> = []
    const repository = new FakeDebateRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const running = orchestrator.start(setup(2))
    await openai.waitForCalls(1)
    await orchestrator.stop()
    const eventCountAtStop = events.length
    openai.releaseCall(0)
    const stopped = await running

    expect(stopped.state).toBe('stopped')
    expect(stopped.messages).toEqual([])
    expect(events).toHaveLength(eventCountAtStop)
    expect(events.some(({ type }) => type === 'message-completed')).toBe(false)
    expect(repository.saved.every(({ messages }) => messages.length === 0)).toBe(true)
  })
})

describe('DebateOrchestrator provider failures', () => {
  it('awaits Retry-After delta-seconds before starting the next attempt', async () => {
    const delays: number[] = []
    let announceSleep = (): void => undefined
    const sleepStarted = new Promise<void>((resolve) => {
      announceSleep = resolve
    })
    let releaseSleep = (): void => undefined
    const sleeping = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    const openai = new FakeProvider([
      { error: new ProviderRetryableError('rate limited', { retryAfter: '17' }) },
      {
        chunks: [
          { type: 'content', content: jsonReply('等待后成功') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      retrySleep: async (delayMs, signal) => {
        expect(signal?.aborted).toBe(false)
        delays.push(delayMs)
        announceSleep()
        await sleeping
      }
    })

    const starting = orchestrator.start(setup(1))
    await sleepStarted
    expect(openai.requests).toHaveLength(1)
    releaseSleep()
    const session = await starting

    expect(delays).toEqual([17_000])
    expect(openai.requests).toHaveLength(2)
    expect(session.messages.map(({ speech }) => speech)).toEqual(['等待后成功'])
  })

  it('parses Retry-After HTTP dates using the injected current time', async () => {
    const now = Date.parse('2026-08-13T00:00:00.000Z')
    const delays: number[] = []
    const openai = new FakeProvider([
      {
        error: new ProviderRetryableError('temporarily unavailable', {
          retryAfter: 'Thu, 13 Aug 2026 00:00:17 GMT'
        })
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('日期等待后成功') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      retryNow: () => now,
      retrySleep: async (delayMs) => {
        delays.push(delayMs)
      }
    })

    await orchestrator.start(setup(1))

    expect(delays).toEqual([17_000])
  })

  it.each([undefined, 'not-a-date'])(
    'uses deterministic jittered exponential backoff for Retry-After %s',
    async (retryAfter) => {
      const delays: number[] = []
      const retryable = (message: string): ProviderRetryableError =>
        new ProviderRetryableError(
          message,
          retryAfter === undefined ? {} : { retryAfter }
        )
      const openai = new FakeProvider([
        { error: retryable('temporary-1') },
        { error: retryable('temporary-2') },
        {
          chunks: [
            { type: 'content', content: jsonReply('退避后成功') },
            { type: 'final', finishReason: 'stop' }
          ]
        }
      ])
      const orchestrator = new DebateOrchestrator({
        ...deterministicDependencies(),
        registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
        repository: new FakeDebateRepository(),
        retryRandom: () => 0.5,
        retrySleep: async (delayMs) => {
          delays.push(delayMs)
        }
      })

      await orchestrator.start(setup(1))

      expect(delays).toEqual([375, 750])
    }
  )

  it('clamps retry waits to the 120-second hard maximum', async () => {
    const delays: number[] = []
    const openai = new FakeProvider([
      {
        error: new ProviderRetryableError('hostile delay', {
          retryAfter: '999999999'
        })
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('封顶后成功') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      retryMaxDelayMs: Number.MAX_SAFE_INTEGER,
      retrySleep: async (delayMs) => {
        delays.push(delayMs)
      }
    })

    await orchestrator.start(setup(1))

    expect(delays).toEqual([120_000])
  })

  it('uses a 30-second default maximum for retry waits', async () => {
    const delays: number[] = []
    const openai = new FakeProvider([
      {
        error: new ProviderRetryableError('long server delay', {
          retryAfter: '999999999'
        })
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('默认封顶后成功') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      retrySleep: async (delayMs) => {
        delays.push(delayMs)
      }
    })

    await orchestrator.start(setup(1))

    expect(delays).toEqual([30_000])
  })

  it('cancels an in-progress retry wait on stop without starting another attempt', async () => {
    let signalSeen: AbortSignal | undefined
    let announceSleep = (): void => undefined
    const sleepStarted = new Promise<void>((resolve) => {
      announceSleep = resolve
    })
    const openai = new FakeProvider([
      { error: new ProviderRetryableError('wait before retry', { retryAfter: '17' }) },
      {
        chunks: [
          { type: 'content', content: jsonReply('绝不应请求') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const events: Array<{ type: string; code?: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository(),
      onEvent: (event) => events.push(event),
      retrySleep: (_delayMs, signal) => {
        signalSeen = signal
        announceSleep()
        return new Promise<void>((_resolve, reject) => {
          const rejectAbort = (): void =>
            reject(signal?.reason ?? new DOMException('stopped', 'AbortError'))
          if (signal?.aborted) {
            rejectAbort()
          } else {
            signal?.addEventListener('abort', rejectAbort, { once: true })
          }
        })
      }
    })

    const starting = orchestrator.start(setup(1))
    await sleepStarted
    expect(signalSeen?.aborted).toBe(false)
    const stopped = await orchestrator.stop()
    const completedStart = await starting

    expect(signalSeen?.aborted).toBe(true)
    expect(openai.requests).toHaveLength(1)
    expect(events.filter(({ type }) => type === 'warning')).toHaveLength(1)
    expect(stopped.state).toBe('stopped')
    expect(completedStart.state).toBe('stopped')
  })

  it('resets a failed attempt draft before streaming the successful retry', async () => {
    const openai = new FakeProvider([
      {
        chunks: [{ type: 'content', content: '失败草稿' }],
        error: new ProviderRetryableError('retry this attempt')
      },
      {
        chunks: [
          { type: 'content', content: jsonReply('成功正文') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new FakeDebateRepository()
    const events: Array<{ type: string; delta?: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const session = await orchestrator.start(setup(1))
    const failedDeltaIndex = events.findIndex(({ delta }) => delta === '失败草稿')
    const resetIndex = events.findIndex(({ type }) => type === 'speech-reset')
    const successfulDeltaIndex = events.findIndex(({ delta }) => delta?.includes('成功正文'))

    expect(failedDeltaIndex).toBeGreaterThan(-1)
    expect(resetIndex).toBeGreaterThan(failedDeltaIndex)
    expect(successfulDeltaIndex).toBeGreaterThan(resetIndex)
    const resetEvent = events[resetIndex]
    expect(debateEventSchema.parse(resetEvent)).toEqual(resetEvent)
    expect(Object.keys(resetEvent ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'roleId',
      'sessionId',
      'turn',
      'type'
    ])
    expect(session.messages.map(({ speech }) => speech)).toEqual(['成功正文'])
    expect(session.events.some(({ type }) => type === 'speech-delta')).toBe(false)
    expect(session.events.some(({ type }) => type === 'speech-reset')).toBe(false)
    expect(JSON.stringify(session)).not.toContain('失败草稿')
    expect(JSON.stringify(repository.saved)).not.toContain('失败草稿')
  })

  it.each([
    {
      label: 'a non-retryable error',
      scripts: [
        {
          chunks: [{ type: 'content' as const, content: '不可重试草稿' }],
          error: new ProviderNonRetryableError('invalid request')
        }
      ],
      state: 'failed',
      expectedResets: 1
    },
    {
      label: 'a refusal error',
      scripts: [
        {
          chunks: [{ type: 'content' as const, content: '拒绝前草稿' }],
          error: new ProviderRefusalError('content refused')
        }
      ],
      state: 'refused',
      expectedResets: 1
    },
    {
      label: 'a refusal finish reason',
      scripts: [
        {
          chunks: [
            { type: 'content' as const, content: '拒绝完成原因前草稿' },
            { type: 'final' as const, finishReason: 'refusal' as const }
          ]
        }
      ],
      state: 'refused',
      expectedResets: 1
    },
    {
      label: 'the final retryable failure',
      scripts: [1, 2, 3].map((attempt) => ({
        chunks: [{ type: 'content' as const, content: `失败草稿${attempt}` }],
        error: new ProviderRetryableError(`temporary-${attempt}`)
      })),
      state: 'failed',
      expectedResets: 3
    }
  ])('resets every partial draft before ending on $label', async ({ scripts, state, expectedResets }) => {
    const openai = new FakeProvider(scripts)
    const repository = new FakeDebateRepository()
    const events: Array<{ type: string; state?: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const session = await orchestrator.start(setup(1))

    expect(session.state).toBe(state)
    const resetIndexes = events.flatMap(({ type }, index) =>
      type === 'speech-reset' ? [index] : []
    )
    expect(resetIndexes).toHaveLength(expectedResets)
    const terminalStateIndex = events.reduce(
      (lastIndex, { type, state: eventState }, index) =>
        type === 'state-changed' && eventState === state ? index : lastIndex,
      -1
    )
    expect(resetIndexes.every((index) => index < terminalStateIndex)).toBe(true)
    expect(session.events.some(({ type }) => type === 'speech-reset')).toBe(false)
    expect(session.messages).toEqual([])
    expect(JSON.stringify(session)).not.toContain('草稿')
    expect(JSON.stringify(repository.saved)).not.toContain('草稿')
  })

  it.each([
    {
      label: 'non-retryable',
      error: new ProviderNonRetryableError('discovery credentials invalid'),
      retryable: false
    },
    {
      label: 'retryable',
      error: new ProviderRetryableError('discovery temporarily unavailable'),
      retryable: true
    }
  ])(
    'fails and persists validation when discovery throws a $label error',
    async ({ error, retryable }) => {
      const openai = new FakeProvider([])
      openai.discover = async () => {
        throw error
      }
      const kimi = new FakeProvider([])
      const repository = new FakeDebateRepository()
      const events: Array<{
        type: string
        code?: string
        roleId?: string
        retryable?: boolean
        state?: string
      }> = []
      const orchestrator = new DebateOrchestrator({
        ...deterministicDependencies(),
        registry: { openai, kimi, deepseek: new FakeProvider([]) },
        repository,
        onEvent: (event) => events.push(event)
      })

      await expect(orchestrator.start(setup(1))).rejects.toBe(error)

      const failed = orchestrator.getSession()
      expect(failed.state).toBe('failed')
      expect(failed.terminationReason).toBe('call-failed')
      expect(failed.currentTurn).toBe(0)
      expect(failed.messages).toEqual([])
      expect(openai.requests).toHaveLength(0)
      expect(kimi.requests).toHaveLength(0)
      expect(events.at(-2)).toMatchObject({
        type: 'warning',
        code: 'provider-discovery-error',
        roleId: 'role-a',
        retryable
      })
      expect(events.at(-1)).toMatchObject({ type: 'state-changed', state: 'failed' })
      expect(repository.saved.at(-1)).toEqual(failed)

      const afterRetry = await orchestrator.retryCurrentTurn()
      expect(afterRetry.state).toBe('failed')
      expect(openai.requests).toHaveLength(0)
      expect(kimi.requests).toHaveLength(0)

      const finished = await orchestrator.finishFailed()
      expect(finished.state).toBe('failed')
      expect(repository.saved.at(-1)).toEqual(finished)
    }
  )

  it('fails and persists validation when the configured model is absent from discovery', async () => {
    const openai = new FakeProvider([
      {
        chunks: [
          { type: 'content', content: jsonReply('不应开始的发言') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    openai.discover = async () => ({
      provider: 'openai',
      models: [
        {
          id: 'gpt-5-mini',
          reasoningEfforts: [],
          thinking: null,
          samplingParameters: [],
          structuredOutputModes: ['json-object']
        }
      ],
      defaultModel: 'gpt-5-mini'
    })
    const kimi = new FakeProvider([])
    const repository = new FakeDebateRepository()
    const events: Array<{
      type: string
      code?: string
      roleId?: string
      retryable?: boolean
      state?: string
    }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi, deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    await expect(orchestrator.start(setup(1))).rejects.toBeInstanceOf(
      ProviderNonRetryableError
    )

    const failed = orchestrator.getSession()
    expect(failed).toMatchObject({
      state: 'failed',
      terminationReason: 'call-failed',
      currentTurn: 0,
      messages: []
    })
    expect(openai.requests).toHaveLength(0)
    expect(kimi.requests).toHaveLength(0)
    expect(events.at(-2)).toMatchObject({
      type: 'warning',
      code: 'provider-discovery-error',
      roleId: 'role-a',
      retryable: false
    })
    expect(events.at(-1)).toMatchObject({ type: 'state-changed', state: 'failed' })
    expect(repository.saved.at(-1)).toEqual(failed)
  })

  it('makes at most three total attempts for retryable errors without saving a message', async () => {
    const openai = new FakeProvider([
      { error: new ProviderRetryableError('temporary-1') },
      { error: new ProviderRetryableError('temporary-2') },
      { error: new ProviderRetryableError('temporary-3') }
    ])
    const repository = new FakeDebateRepository()
    const events: Array<{ type: string; attempt?: number; code?: string }> = []
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository,
      onEvent: (event) => events.push(event)
    })

    const session = await orchestrator.start(setup(1))

    expect(openai.requests).toHaveLength(3)
    expect(
      events
        .filter(({ type, code }) => type === 'warning' && code === 'provider-error')
        .map(({ attempt }) => attempt)
    ).toEqual([1, 2, 3])
    for (const event of events) {
      expect(debateEventSchema.parse(event)).toEqual(event)
    }
    expect(session.state).toBe('failed')
    expect(session.terminationReason).toBe('call-failed')
    expect(session.currentTurn).toBe(0)
    expect(session.messages).toEqual([])
    expect(repository.saved.every(({ messages }) => messages.length === 0)).toBe(true)
  })

  it('does not retry a non-retryable provider error', async () => {
    const openai = new FakeProvider([
      { error: new ProviderNonRetryableError('401 invalid credentials') }
    ])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    const session = await orchestrator.start(setup(1))

    expect(openai.requests).toHaveLength(1)
    expect(session.state).toBe('failed')
    expect(session.currentTurn).toBe(0)
  })

  it('retries the same speaker on demand after failure and saves only its successful reply', async () => {
    const openai = new FakeProvider([
      { error: new ProviderRetryableError('temporary-1') },
      { error: new ProviderRetryableError('temporary-2') },
      { error: new ProviderRetryableError('temporary-3') },
      {
        chunks: [
          { type: 'content', content: jsonReply('重试后的正式回复') },
          { type: 'final', finishReason: 'stop' }
        ]
      }
    ])
    const repository = new FakeDebateRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository
    })

    const failed = await orchestrator.start(setup(1))
    expect(failed.state).toBe('failed')

    const retried = await orchestrator.retryCurrentTurn()

    expect(openai.requests).toHaveLength(4)
    expect(retried.state).toBe('unresolved')
    expect(retried.currentTurn).toBe(1)
    expect(retried.messages.map(({ roleId, speech }) => ({ roleId, speech }))).toEqual([
      { roleId: 'role-a', speech: '重试后的正式回复' }
    ])
    expect(repository.saved.flatMap(({ messages }) => messages).every(({ turn }) => turn === 1))
      .toBe(true)
  })

  it('can explicitly finish a failed debate without another provider call', async () => {
    const openai = new FakeProvider([
      { error: new ProviderNonRetryableError('invalid model') }
    ])
    const repository = new FakeDebateRepository()
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository
    })

    await orchestrator.start(setup(1))
    const finished = await orchestrator.finishFailed()

    expect(finished.state).toBe('failed')
    expect(finished.terminationReason).toBe('call-failed')
    expect(openai.requests).toHaveLength(1)
    expect(repository.saved.at(-1)?.state).toBe('failed')
  })

  it.each([
    {
      label: 'throws ProviderRefusalError',
      script: { error: new ProviderRefusalError('content refused') }
    },
    {
      label: 'returns a refusal finish reason',
      script: {
        chunks: [
          { type: 'content' as const, content: '{"speech":"不会成为正式消息"' },
          { type: 'final' as const, finishReason: 'refusal' as const }
        ]
      }
    }
  ])('enters refused when the provider $label', async ({ script }) => {
    const openai = new FakeProvider([script])
    const orchestrator = new DebateOrchestrator({
      ...deterministicDependencies(),
      registry: { openai, kimi: new FakeProvider([]), deepseek: new FakeProvider([]) },
      repository: new FakeDebateRepository()
    })

    const session = await orchestrator.start(setup(1))

    expect(openai.requests).toHaveLength(1)
    expect(session.state).toBe('refused')
    expect(session.terminationReason).toBe('provider-refusal')
    expect(session.currentTurn).toBe(0)
    expect(session.messages).toEqual([])
  })
})
