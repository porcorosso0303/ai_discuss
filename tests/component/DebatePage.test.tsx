// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../../src/renderer/src/App'
import { DebatePage } from '../../src/renderer/src/pages/DebatePage'
import {
  createDebateViewState,
  debateViewReducer
} from '../../src/renderer/src/hooks/use-debate-events'
import type { AiDebatesApi } from '../../src/preload'
import type { DebateEvent, DebateSession, RoleConfig } from '../../src/shared/domain'

const roles: [RoleConfig, RoleConfig] = [
  {
    roleId: 'role-a', name: '理性派', personaOrStance: '支持', provider: 'openai',
    model: 'gpt-test', effort: 'high'
  },
  {
    roleId: 'role-b', name: '现实派', personaOrStance: '反对', provider: 'deepseek',
    model: 'deepseek-test', baseUrl: 'https://api.deepseek.com/', thinking: true,
    effort: 'high', maxTokens: 4096
  }
]

const now = '2026-08-24T08:00:00.000Z'

type DebateEventInput<Event extends DebateEvent = DebateEvent> = Event extends DebateEvent
  ? Omit<Event, 'id' | 'sessionId' | 'createdAt'> & Partial<Pick<Event, 'id' | 'sessionId' | 'createdAt'>>
  : never

function event(value: DebateEventInput): DebateEvent {
  return { id: crypto.randomUUID(), sessionId: 'session-1', createdAt: now, ...value } as DebateEvent
}

function session(overrides: Partial<DebateSession> = {}): DebateSession {
  return {
    id: 'session-1',
    setup: { topic: '测试话题', roles, firstSpeaker: 'role-a', maxTurns: 100 },
    state: 'completed', messages: [], events: [], currentTurn: 1,
    createdAt: now, updatedAt: now, contextCompressed: false,
    terminationReason: 'agreed',
    ...overrides
  }
}

function apiHarness(options: { delayedStart?: boolean } = {}) {
  let debateListener: ((payload: DebateEvent) => void) | undefined
  let resolveStart!: (value: { session: DebateSession }) => void
  const startResult = options.delayedStart
    ? new Promise<{ session: DebateSession }>((resolve) => { resolveStart = resolve })
    : Promise.resolve({ session: session() })
  const unsubscribeDebate = vi.fn()
  const api = {
    app: { getVersion: vi.fn() },
    config: {
      listRoles: vi.fn(async () => ({ roles: [] })), saveRole: vi.fn(async ({ role }) => ({ role })),
      deleteRole: vi.fn()
    },
    credentials: {
      setProviderSecret: vi.fn(), deleteProviderSecret: vi.fn(),
      hasProviderSecret: vi.fn(async () => ({ found: true }))
    },
    openAI: {
      getAuthStatus: vi.fn(async () => ({ status: 'signed-in' as const })),
      startLogin: vi.fn(), logout: vi.fn(), onAuthChanged: vi.fn(() => vi.fn())
    },
    providers: { discoverCapabilities: vi.fn(), testConnection: vi.fn() },
    debate: {
      start: vi.fn(() => startResult), pause: vi.fn(async () => ({ accepted: true })),
      resume: vi.fn(async () => ({ accepted: true })), stop: vi.fn(async () => ({ accepted: true })),
      retryCurrentTurn: vi.fn(async () => ({ accepted: true })),
      onEvent: vi.fn((listener) => { debateListener = listener; return unsubscribeDebate })
    },
    history: { list: vi.fn(), get: vi.fn(), delete: vi.fn(), clear: vi.fn() },
    export: { markdown: vi.fn() }
  } as unknown as AiDebatesApi
  Object.defineProperty(window, 'aiDebates', { configurable: true, value: api })
  return {
    api, unsubscribeDebate,
    emit: (payload: DebateEvent) => act(() => debateListener?.(payload)),
    finish: (value = session()) => act(() => resolveStart({ session: value }))
  }
}

afterEach(cleanup)

describe('debate event reducer', () => {
  it('streams a draft, resets it, promotes a formal message, and ignores duplicates and late deltas', () => {
    let state = createDebateViewState()
    const delta = event({ id: 'delta-1', type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '第一段' })
    state = debateViewReducer(state, { type: 'event', event: delta })
    state = debateViewReducer(state, { type: 'event', event: delta })
    expect(state.drafts['role-a:1']?.speech).toBe('第一段')

    state = debateViewReducer(state, { type: 'event', event: event({ type: 'speech-reset', roleId: 'role-a', turn: 1 }) })
    expect(state.drafts['role-a:1']).toBeUndefined()
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '正式内容' }) })
    state = debateViewReducer(state, { type: 'event', event: event({
      type: 'message-completed',
      message: {
        id: 'message-1', turn: 1, roleId: 'role-a', provider: 'openai', model: 'gpt-test',
        speech: '正式内容', status: 'continue', createdAt: now
      }
    }) })
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '迟到内容' }) })
    expect(state.messages).toHaveLength(1)
    expect(state.drafts['role-a:1']).toBeUndefined()
  })

  it('binds the first session, ignores another session, and clears drafts only at terminal states', () => {
    let state = createDebateViewState()
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'speech-delta', roleId: 'role-b', turn: 2, delta: '草稿' }) })
    state = debateViewReducer(state, { type: 'event', event: event({ id: 'foreign', sessionId: 'other', type: 'state-changed', state: 'paused' }) })
    expect(state.phase).toBe('starting')
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'state-changed', state: 'paused' }) })
    expect(state.drafts['role-b:2']).toBeDefined()
    state = debateViewReducer(state, { type: 'discard-drafts' })
    expect(state.drafts).toEqual({})
  })

  it('treats a terminal start response as authoritative over older embedded events', () => {
    const oldRunning = event({ id: 'old-running', type: 'state-changed', state: 'running' })
    const final = session({ state: 'unresolved', terminationReason: 'max-turns', events: [oldRunning] })
    const state = debateViewReducer(createDebateViewState(), { type: 'session', session: final })
    expect(state.phase).toBe('unresolved')
    expect(state.session).toBe(final)
  })
})

describe('live debate page', () => {
  beforeEach(() => apiHarness())

  it('validates setup and starts with first speaker A and default 100 turns', async () => {
    const { api } = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请输入辩论话题')
    await user.type(screen.getByLabelText('辩论话题'), '人工智能是否改善教育公平')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    expect(api.debate.start).toHaveBeenCalledWith({ setup: expect.objectContaining({
      topic: '人工智能是否改善教育公平', firstSpeaker: 'role-a', maxTurns: 100, roles
    }) })
    expect(screen.getByText('正在启动')).toBeInTheDocument()
  })

  it('shows streamed speech before the start promise resolves without rendering hidden payloads', async () => {
    const harness = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '流式话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'turn-started', roleId: 'role-a', turn: 1 }))
    harness.emit(event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '正在生成的观点' }))
    expect(screen.getByText('正在生成的观点')).toBeInTheDocument()
    expect(screen.getByText('正在发言')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('rawPayload')
    expect(document.body).not.toHaveTextContent('DEBATE_RESULT')
  })

  it('can retry a rejected start request with the same validated setup', async () => {
    const harness = apiHarness({ delayedStart: true })
    ;(harness.api.debate.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(new Promise(() => undefined))
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '重试话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法启动辩论，请重试')
    await user.click(screen.getByRole('button', { name: '重新启动辩论' }))
    expect(harness.api.debate.start).toHaveBeenCalledTimes(2)
    expect((harness.api.debate.start as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toEqual(
      (harness.api.debate.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    )
  })

  it('pauses, resumes, and stops by session id while discarding the draft immediately', async () => {
    const harness = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '控制话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'running' }))
    harness.emit(event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '临时内容' }))
    await user.click(screen.getByRole('button', { name: '暂停辩论' }))
    expect(harness.api.debate.pause).toHaveBeenCalledWith({ sessionId: 'session-1' })
    harness.emit(event({ type: 'state-changed', state: 'paused' }))
    await user.click(screen.getByRole('button', { name: '继续辩论' }))
    expect(harness.api.debate.resume).toHaveBeenCalledWith({ sessionId: 'session-1' })
    await user.click(screen.getByRole('button', { name: '停止辩论' }))
    expect(harness.api.debate.stop).toHaveBeenCalledWith({ sessionId: 'session-1' })
    expect(screen.queryByText('临时内容')).not.toBeInTheDocument()
  })

  it.each([
    ['conceded', 'role-a', '理性派 获胜'],
    ['agreed', undefined, '双方达成一致'],
    ['max-turns', undefined, '达到轮次上限，尚未决出结果']
  ] as const)('renders the %s result', async (reason, winner, expected) => {
    apiHarness()
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '结果话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    await screen.findByRole('region', { name: '辩论结果' })
    // Start response supplied by a fresh harness defaults to agreed; replace through reducer-level merge.
    cleanup()
    const delayed = apiHarness({ delayedStart: true })
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '结果话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    delayed.finish(session({ terminationReason: reason, winnerRoleId: winner }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it('shows the unresolved result before the final session response arrives', async () => {
    const harness = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '未决话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'unresolved' }))
    expect(screen.getByText('达到轮次上限，尚未决出结果')).toBeInTheDocument()
  })

  it('auto-scrolls only while the reader remains near the bottom', async () => {
    const harness = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { callback(0); return 1 })
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '滚动话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    const timeline = screen.getByRole('log', { name: '辩论对话' })
    Object.defineProperties(timeline, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, writable: true, value: 700 }
    })
    const scrollTo = vi.fn()
    Object.defineProperty(timeline, 'scrollTo', { configurable: true, value: scrollTo })
    fireEvent.scroll(timeline)
    harness.emit(event({ type: 'state-changed', state: 'running' }))
    expect(scrollTo).not.toHaveBeenCalled()
    harness.emit(event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '底部更新' }))
    expect(scrollTo).toHaveBeenCalled()
    scrollTo.mockClear()
    ;(timeline as HTMLElement).scrollTop = 100
    fireEvent.scroll(timeline)
    harness.emit(event({ type: 'speech-delta', roleId: 'role-a', turn: 1, delta: '上读更新' }))
    expect(scrollTo).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('unsubscribes exactly once on unmount', () => {
    const { unsubscribeDebate } = apiHarness()
    const rendered = render(<DebatePage roles={roles} onBack={vi.fn()} />)
    rendered.unmount()
    expect(unsubscribeDebate).toHaveBeenCalledTimes(1)
  })
})

describe('configuration navigation', () => {
  it('enters debate setup with two tested roles and marks the debate navigation active', async () => {
    const { api } = apiHarness()
    const catalog = (provider: 'openai' | 'deepseek') => ({
      provider,
      defaultModel: provider === 'openai' ? 'gpt-test' : 'deepseek-test',
      models: [{
        id: provider === 'openai' ? 'gpt-test' : 'deepseek-test', reasoningEfforts: ['high'],
        defaultReasoningEffort: 'high', thinking: provider === 'openai' ? null : { default: true, keepSupported: false },
        maxOutputTokens: 4096, samplingParameters: [], structuredOutputModes: ['json-schema']
      }]
    })
    ;(api.providers.discoverCapabilities as ReturnType<typeof vi.fn>).mockImplementation(async ({ provider }) => catalog(provider))
    ;(api.providers.testConnection as ReturnType<typeof vi.fn>).mockImplementation(async ({ provider }) => ({ ok: true, capabilities: catalog(provider) }))
    const user = userEvent.setup()
    render(<App />)
    const cards = await screen.findAllByRole('region', { name: /角色 [AB] 配置/ })
    for (const card of cards) {
      await user.click(within(card).getByRole('button', { name: '获取模型' }))
      await user.click(within(card).getByRole('button', { name: '测试连接' }))
    }
    await user.click(screen.getByRole('button', { name: '进入辩论设置' }))
    expect(await screen.findByRole('heading', { name: '设置辩论话题' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '辩论现场' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: '历史记录' })).toHaveAttribute('aria-disabled', 'true')
  })
})
