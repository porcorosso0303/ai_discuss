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

async function captureUnhandled(operation: () => Promise<void> | void): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await operation()
    await new Promise((resolve) => setTimeout(resolve, 10))
    return unhandled
  } finally {
    process.off('unhandledRejection', listener)
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
      start: vi.fn(() => startResult), recover: vi.fn(async () => ({ session: session({ state: 'paused', terminationReason: undefined }) })),
      pause: vi.fn(async () => ({ accepted: true })),
      resume: vi.fn(async () => ({ accepted: true })), stop: vi.fn(async () => ({ accepted: true })),
      retryCurrentTurn: vi.fn(async () => ({ accepted: true })),
      onEvent: vi.fn((listener) => { debateListener = listener; return unsubscribeDebate })
    },
    history: {
      list: vi.fn(async () => ({ sessions: [] })),
      get: vi.fn(async () => ({ session: null })), delete: vi.fn(), clear: vi.fn()
    },
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
  it.each(['running', 'pausing', 'paused'] as const)(
    'restores %s from formal snapshot data and ignores persisted partial turn events',
    (stateName) => {
      const formal = {
        id: 'formal-1', turn: 1, roleId: 'role-a' as const, provider: 'openai' as const,
        model: 'gpt-test', speech: '正式第一轮', status: 'continue' as const, createdAt: now
      }
      const restored = session({
        state: stateName, terminationReason: undefined, currentTurn: 1, messages: [formal],
        events: [
          event({ id: 'completed-old', type: 'message-completed', message: formal }),
          event({ id: 'started-partial', type: 'turn-started', roleId: 'role-b', turn: 2 }),
          event({ id: 'delta-partial', type: 'speech-delta', roleId: 'role-b', turn: 2, delta: '不应恢复的残片' }),
          event({ id: 'warning-old', type: 'warning', code: 'notice', message: '保留的提示' }),
          event({ id: 'compressed-old', type: 'context-compressed', roleId: 'role-a', throughTurn: 1 }),
          event({ id: 'usage-old', type: 'usage-updated', roleId: 'role-a', usage: {
            inputTokens: 2, outputTokens: 3, totalTokens: 5
          } })
        ]
      })

      let state = createDebateViewState(restored)
      expect(state.phase).toBe(stateName)
      expect(state.currentTurn).toBe(1)
      expect(state.messages).toEqual([formal])
      expect(state.drafts).toEqual({})
      expect(state.completedTurns).toContain('role-a:1')
      expect(state.warnings.map(({ message }) => message)).toEqual(['保留的提示'])
      expect(state.compressedRoles).toEqual(['role-a'])
      expect(state.usage['role-a']?.totalTokens).toBe(5)

      state = debateViewReducer(state, { type: 'event', event: event({
        id: 'fresh-delta', type: 'speech-delta', roleId: 'role-b', turn: 2, delta: '全新内容'
      }) })
      expect(state.drafts['role-b:2']?.speech).toBe('全新内容')
    }
  )

  it('restarts a rejected validation attempt and quarantines its late responses and events', () => {
    const setup = session().setup
    let state = debateViewReducer(createDebateViewState(), { type: 'begin', setup, attempt: 1 })
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'state-changed', state: 'validating' }) })
    state = debateViewReducer(state, { type: 'start-error', attempt: 1, message: '无法启动辩论，请重试' })
    expect(state.startRejected).toBe(true)

    state = debateViewReducer(state, { type: 'begin', setup, attempt: 2 })
    state = debateViewReducer(state, { type: 'start-error', attempt: 1, message: '旧失败' })
    state = debateViewReducer(state, { type: 'session', attempt: 1, session: session({ state: 'completed' }) })
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'state-changed', state: 'completed' }) })
    expect(state.phase).toBe('starting')
    expect(state.error).toBeUndefined()

    state = debateViewReducer(state, { type: 'event', event: event({ sessionId: 'session-2', type: 'state-changed', state: 'validating' }) })
    expect(state.sessionId).toBe('session-2')
    expect(state.phase).toBe('validating')
  })

  it.each(['completed', 'unresolved'] as const)('keeps a terminal %s result when start rejects late', (terminal) => {
    let state = debateViewReducer(createDebateViewState(), {
      type: 'begin', setup: session().setup, attempt: 1
    })
    state = debateViewReducer(state, { type: 'event', event: event({ type: 'state-changed', state: terminal }) })
    state = debateViewReducer(state, {
      type: 'start-error', attempt: 1, message: '迟到的请求失败'
    })
    expect(state.phase).toBe(terminal)
    expect(state.error).toBeUndefined()
  })

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
    const state = debateViewReducer(createDebateViewState(), { type: 'session', attempt: 0, session: final })
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

  it('loads a recovered session as paused and makes no request until continue is clicked', async () => {
    const harness = apiHarness()
    const recovered = session({
      state: 'paused', terminationReason: undefined, currentTurn: 1,
      messages: [{
        id: 'restored-message', turn: 1, roleId: 'role-a', provider: 'openai', model: 'gpt-test',
        speech: '恢复前的发言', status: 'continue', createdAt: now
      }]
    })
    const user = userEvent.setup()

    render(<DebatePage roles={roles} initialSession={recovered} onBack={vi.fn()} />)

    expect(screen.getByText('已恢复，等待用户继续')).toBeInTheDocument()
    expect(screen.getByText('恢复前的发言')).toBeInTheDocument()
    expect(screen.getByText('已暂停')).toBeInTheDocument()
    expect(harness.api.debate.start).not.toHaveBeenCalled()
    expect(harness.api.debate.resume).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '继续辩论' }))
    expect(harness.api.debate.resume).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })

  it('offers configuration repair instead of turn retry when recovered model validation fails', async () => {
    const harness = apiHarness()
    const onBack = vi.fn()
    const recovered = session({ state: 'paused', terminationReason: undefined, currentTurn: 0, messages: [] })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} initialSession={recovered} onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: '继续辩论' }))
    harness.emit(event({
      type: 'warning', code: 'provider-discovery-error', roleId: 'role-a',
      message: 'configured model unavailable', retryable: false
    }))
    harness.emit(event({ type: 'state-changed', state: 'failed' }))

    expect(screen.getByRole('alert')).toHaveTextContent('模型配置已变化，请返回角色配置后重新测试')
    expect(screen.getByRole('button', { name: '重试当前轮' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '返回角色配置' }))
    expect(onBack).toHaveBeenCalledOnce()
    expect(harness.api.debate.retryCurrentTurn).not.toHaveBeenCalled()
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

  it('restarts after validation failure even when that attempt already emitted a session id', async () => {
    const harness = apiHarness({ delayedStart: true })
    let rejectFirst!: (error: Error) => void
    ;(harness.api.debate.start as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockReturnValueOnce(new Promise(() => undefined))
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '校验失败话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'validating' }))
    await act(async () => rejectFirst(new Error('validation failed')))

    await user.click(await screen.findByRole('button', { name: '重新启动辩论' }))

    expect(harness.api.debate.start).toHaveBeenCalledTimes(2)
    expect(harness.api.debate.retryCurrentTurn).not.toHaveBeenCalled()
    harness.emit(event({ type: 'state-changed', state: 'completed' }))
    expect(screen.getByText('正在启动')).toBeInTheDocument()
    harness.emit(event({ sessionId: 'session-2', type: 'state-changed', state: 'validating' }))
    expect(screen.getByText('正在校验')).toBeInTheDocument()
  })

  it('marks every invalid setup field and focuses the first invalid field', async () => {
    apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    const maxTurns = screen.getByLabelText('最大轮次')
    await user.clear(maxTurns)
    await user.type(maxTurns, '101')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))

    const topic = screen.getByLabelText('辩论话题')
    expect(topic).toHaveFocus()
    expect(topic).toHaveAttribute('aria-invalid', 'true')
    expect(maxTurns).toHaveAttribute('aria-invalid', 'true')
    expect(maxTurns).toHaveAttribute('aria-describedby', 'debate-max-turns-error')
    expect(screen.getByText('轮次必须在 1 到 100 之间')).toHaveAttribute('id', 'debate-max-turns-error')
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

  it('treats failed as terminal for stop while preserving turn retry', async () => {
    const harness = apiHarness({ delayedStart: true })
    const user = userEvent.setup()
    render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '失败话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'running' }))
    harness.emit(event({ type: 'state-changed', state: 'failed' }))

    expect(screen.getByRole('button', { name: '停止辩论' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重试当前轮' })).toBeEnabled()
  })

  it('contains a late control rejection after unmount', async () => {
    const harness = apiHarness({ delayedStart: true })
    let rejectResume!: (error: Error) => void
    ;(harness.api.debate.resume as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((_resolve, reject) => { rejectResume = reject })
    )
    const user = userEvent.setup()
    const rendered = render(<DebatePage roles={roles} onBack={vi.fn()} />)
    await user.type(screen.getByLabelText('辩论话题'), '卸载竞态')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'paused' }))
    await user.click(screen.getByRole('button', { name: '继续辩论' }))
    rendered.unmount()

    const unhandled = await captureUnhandled(async () => { rejectResume(new Error('late failure')) })
    expect(unhandled).toEqual([])
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
  it('opens history and mounts a recovered session from its saved role snapshot without auto-resuming', async () => {
    const harness = apiHarness()
    const recovered = session({
      state: 'paused', terminationReason: undefined, currentTurn: 0,
      messages: [], updatedAt: '2026-08-24T09:00:00.000Z'
    })
    ;(harness.api.history.list as ReturnType<typeof vi.fn>).mockResolvedValue({ sessions: [{
      id: recovered.id, topic: recovered.setup.topic, state: recovered.state,
      currentTurn: recovered.currentTurn, createdAt: recovered.createdAt, updatedAt: recovered.updatedAt
    }] })
    ;(harness.api.history.get as ReturnType<typeof vi.fn>).mockResolvedValue({ session: recovered })
    ;(harness.api.debate.recover as ReturnType<typeof vi.fn>).mockResolvedValue({ session: recovered })
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '历史记录' }))
    expect(await screen.findByRole('heading', { name: '辩论档案' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '历史记录' })).toHaveAttribute('aria-current', 'page')
    await user.click(await screen.findByRole('button', { name: /查看测试话题/ }))
    await user.click(await screen.findByRole('button', { name: '加载并恢复' }))

    expect(await screen.findByText('已恢复，等待用户继续')).toBeInTheDocument()
    expect(harness.api.debate.start).not.toHaveBeenCalled()
    expect(harness.api.debate.resume).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '角色配置' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '历史记录' })).toBeDisabled()
  })

  it('navigates with buttons and locks configuration while a debate is active', async () => {
    const harness = apiHarness({ delayedStart: true })
    const { api } = harness
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
    const debateNavigation = screen.getByRole('button', { name: '辩论现场' })
    expect(debateNavigation).toBeEnabled()
    await user.click(debateNavigation)
    expect(await screen.findByRole('heading', { name: '设置辩论话题' })).toBeInTheDocument()
    expect(debateNavigation).toHaveAttribute('aria-current', 'page')
    const configuration = screen.getByRole('button', { name: '角色配置' })
    expect(configuration).toBeEnabled()
    await user.click(configuration)
    expect(await screen.findByRole('heading', { name: '配置 AI 角色' })).toBeInTheDocument()
    await user.click(debateNavigation)
    expect(await screen.findByRole('heading', { name: '设置辩论话题' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('辩论话题'), '导航锁定话题')
    await user.click(screen.getByRole('button', { name: '开始辩论' }))
    harness.emit(event({ type: 'state-changed', state: 'running' }))
    expect(configuration).toBeDisabled()
    harness.emit(event({ type: 'state-changed', state: 'unresolved' }))
    expect(configuration).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '返回角色配置' }))
    expect(await screen.findByRole('heading', { name: '配置 AI 角色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '历史记录' })).toBeEnabled()
  })
})
