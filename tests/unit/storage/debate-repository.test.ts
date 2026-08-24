import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DebateRepository } from '../../../src/main/storage/debate-repository'
import {
  DEBATE_SESSION_STATES,
  type DebateSession,
  type DebateSessionState
} from '../../../src/shared/domain'
import { createSession } from '../../helpers/debate-fixtures'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

describe('DebateRepository', () => {
  afterEach(removeTempDirectories)

  it('saves, lists, searches, gets, deletes, and clears bounded history', async () => {
    const root = await createTempDirectory('debate-repository-')
    const repository = new DebateRepository(root)
    const first = createSession()
    const second = createSession({
      id: 'session-2',
      setup: { ...createSession().setup, topic: 'SHOULD Robots 教中文?' },
      createdAt: '2026-08-12T10:00:00.000Z',
      updatedAt: '2026-08-12T10:00:00.000Z'
    })
    await repository.saveSession(first)
    await repository.saveSession(second)

    expect((await repository.list()).map(({ id }) => id)).toEqual(['session-2', 'session-1'])
    expect((await repository.list({ search: 'robots 教', limit: 20 })).map(({ id }) => id)).toEqual([
      'session-2'
    ])
    expect((await repository.list({ search: 'should', limit: 1 }))[0]?.id).toBe('session-2')

    const loaded = await repository.get('session-1')
    expect(loaded).toEqual(first)
    if (loaded) loaded.setup.topic = '外部篡改'
    expect((await repository.get('session-1'))?.setup.topic).toBe(first.setup.topic)

    expect(await repository.delete('session-1')).toBe(true)
    expect(await repository.delete('session-1')).toBe(false)
    expect(await repository.clear()).toBe(1)
    expect(await repository.list()).toEqual([])
  })

  it('treats session files as source of truth and heals a missing or corrupt index', async () => {
    const root = await createTempDirectory('debate-repository-heal-')
    const repository = new DebateRepository(root)
    await repository.saveSession(createSession())
    await writeFile(join(root, 'debates/index.json'), '{broken')

    expect((await repository.list())[0]?.id).toBe('session-1')
    const healed = JSON.parse(await readFile(join(root, 'debates/index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>
    }
    expect(healed.sessions[0]?.id).toBe('session-1')
  })

  it('skips corrupt session files without losing valid history', async () => {
    const root = await createTempDirectory('debate-repository-corrupt-')
    const repository = new DebateRepository(root)
    await repository.saveSession(createSession())
    await writeFile(join(root, 'debates/corrupt.json'), '{"authorization":"Bearer stolen"}')

    expect((await repository.list()).map(({ id }) => id)).toEqual(['session-1'])
  })

  it('returns incomplete sessions only as passive recovery candidates', async () => {
    const root = await createTempDirectory('debate-repository-recovery-')
    const repository = new DebateRepository(root)
    await repository.saveSession(createSession({ state: 'running' }))

    expect(await repository.getRecoveryCandidate('session-1')).toEqual({
      session: createSession({ state: 'running' }),
      requiresUserResume: true
    })

    await repository.saveSession(
      createSession({
        state: 'completed',
        terminationReason: 'agreed',
        updatedAt: '2026-08-11T10:01:00.000Z'
      })
    )
    expect(await repository.getRecoveryCandidate('session-1')).toBeNull()
  })

  it('does not let a stale concurrent save overwrite a newer terminal snapshot', async () => {
    const root = await createTempDirectory('debate-repository-stale-')
    const repository = new DebateRepository(root)
    const terminal = createSession({
      state: 'completed',
      terminationReason: 'agreed',
      updatedAt: '2026-08-11T10:02:00.000Z'
    })
    const stale = createSession({ state: 'running', updatedAt: '2026-08-11T10:03:00.000Z' })

    await Promise.all([repository.saveSession(terminal), repository.saveSession(stale)])

    expect((await repository.get('session-1'))?.state).toBe('completed')
  })

  it('keeps a terminal snapshot across concurrent repository instances', async () => {
    const root = await createTempDirectory('debate-repository-cross-instance-')
    const first = new DebateRepository(root)
    const second = new DebateRepository(root)
    const terminal = createSession({
      state: 'completed',
      terminationReason: 'agreed',
      updatedAt: '2026-08-11T10:02:00.000Z'
    })
    const delayedRunning = createSession({
      state: 'running',
      updatedAt: '2026-08-11T10:03:00.000Z'
    })

    await Promise.all([first.saveSession(terminal), second.saveSession(delayedRunning)])

    expect((await first.get('session-1'))?.state).toBe('completed')
  })

  it('orders delete, clear, and save across repository instances', async () => {
    const root = await createTempDirectory('debate-repository-ordering-')
    const first = new DebateRepository(root)
    const second = new DebateRepository(root)
    await first.saveSession(createSession())

    const deletion = first.delete('session-1')
    const saving = second.saveSession(createSession({ id: 'session-2' }))
    const clearing = first.clear()
    await Promise.all([deletion, saving, clearing])

    expect(await second.list()).toEqual([])
  })

  it('deterministically keeps terminal state on equal timestamps', async () => {
    const root = await createTempDirectory('debate-repository-equal-time-')
    const first = new DebateRepository(root)
    const second = new DebateRepository(root)
    const updatedAt = '2026-08-11T10:02:00.000Z'
    await Promise.all([
      first.saveSession(
        createSession({ state: 'completed', terminationReason: 'agreed', updatedAt })
      ),
      second.saveSession(createSession({ state: 'running', updatedAt }))
    ])

    expect((await first.get('session-1'))?.state).toBe('completed')
  })

  it('rejects unsafe session ids and nested secret payloads before a file is created', async () => {
    const root = await createTempDirectory('debate-repository-security-')
    const repository = new DebateRepository(root)

    await expect(repository.saveSession(createSession({ id: '../escape' }))).rejects.toThrow()
    await expect(
      repository.saveSession({
        ...createSession(),
        hidden: { apiToken: 'must-not-persist' }
      } as unknown as DebateSession)
    ).rejects.toThrow()
    await mkdir(join(root, 'debates'), { recursive: true })
    expect(await readFile(join(root, 'escape.json'), 'utf8').catch(() => null)).toBeNull()
  })

  it('accepts exactly 5000 external session files but rejects 5001 without replacing the index', async () => {
    const root = await createTempDirectory('debate-repository-cap-')
    const repository = new DebateRepository(root)
    await writeExternalSessions(root, 5_000)

    expect(await repository.list({ limit: 1 })).toHaveLength(1)
    const indexBeforeOverflow = await readFile(join(root, 'debates/index.json'), 'utf8')

    await writeExternalSession(root, 5_000)

    await expect(repository.list({ limit: 1 })).rejects.toThrow(/too many session files/i)
    expect(await readFile(join(root, 'debates/index.json'), 'utf8')).toBe(indexBeforeOverflow)
  }, 30_000)

  it('clears all 5001 session files in bounded batches and writes an empty index only after confirmation', async () => {
    const root = await createTempDirectory('debate-repository-clear-over-cap-')
    const repository = new DebateRepository(root)
    await writeExternalSessions(root, 5_001)

    expect(await repository.clear()).toBe(5_001)
    expect(await repository.list()).toEqual([])
    expect(JSON.parse(await readFile(join(root, 'debates/index.json'), 'utf8'))).toEqual({
      sessions: []
    })
  }, 30_000)

  it('throws on a partial clear failure and heals the index to the surviving session', async () => {
    const root = await createTempDirectory('debate-repository-clear-partial-')
    const repository = new DebateRepository(root)
    await repository.saveSession(createSession({ id: 'session-0000' }))
    await repository.saveSession(createSession({ id: 'session-0002' }))
    await mkdir(join(root, 'debates/session-0001.json'))

    await expect(repository.clear()).rejects.toThrow(/regular non-symlink file/i)

    const index = JSON.parse(await readFile(join(root, 'debates/index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>
    }
    expect(index.sessions.map(({ id }) => id)).toEqual(['session-0002'])
    expect((await repository.get('session-0002'))?.id).toBe('session-0002')
  })

  it('orders histories by parsed instants rather than RFC 3339 text offsets', async () => {
    const root = await createTempDirectory('debate-repository-offset-order-')
    const repository = new DebateRepository(root)
    await repository.saveSession(
      createSession({
        id: 'earlier',
        createdAt: '2026-08-11T10:30:00+01:00',
        updatedAt: '2026-08-11T10:30:00+01:00'
      })
    )
    await repository.saveSession(
      createSession({
        id: 'later',
        createdAt: '2026-08-11T10:00:00Z',
        updatedAt: '2026-08-11T10:00:00Z'
      })
    )

    expect((await repository.list()).map(({ id }) => id)).toEqual(['later', 'earlier'])
  })

  it('lets a terminal snapshot beat a future-dated nonterminal snapshot despite clock skew', async () => {
    const root = await createTempDirectory('debate-repository-clock-skew-')
    const repository = new DebateRepository(root)
    await repository.saveSession(
      createSession({ state: 'running', updatedAt: '2026-08-12T10:00:00Z' })
    )
    await repository.saveSession(
      createSession({
        state: 'completed',
        terminationReason: 'agreed',
        updatedAt: '2026-08-11T10:00:00Z'
      })
    )

    expect((await repository.get('session-1'))?.state).toBe('completed')
  })

  it('resolves every same-instant state conflict identically in either arrival order', async () => {
    const terminalPriority: Partial<Record<DebateSessionState, number>> = {
      failed: 5,
      refused: 6,
      unresolved: 7,
      stopped: 8,
      completed: 9
    }
    const terminalStates = new Set(Object.keys(terminalPriority) as DebateSessionState[])

    for (let leftIndex = 0; leftIndex < DEBATE_SESSION_STATES.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < DEBATE_SESSION_STATES.length; rightIndex += 1) {
        const leftState = DEBATE_SESSION_STATES[leftIndex]
        const rightState = DEBATE_SESSION_STATES[rightIndex]
        const left = createSession({ state: leftState, updatedAt: '2026-08-11T18:00:00+08:00' })
        const right = createSession({ state: rightState, updatedAt: '2026-08-11T10:00:00Z' })
        const leftTerminal = terminalStates.has(leftState)
        const rightTerminal = terminalStates.has(rightState)
        const expected =
          leftTerminal !== rightTerminal
            ? leftTerminal
              ? leftState
              : rightState
            : leftTerminal
              ? (terminalPriority[leftState] ?? 0) > (terminalPriority[rightState] ?? 0)
                ? leftState
                : rightState
              : JSON.stringify(left) > JSON.stringify(right)
                ? leftState
                : rightState

        const forwardRoot = await createTempDirectory('debate-repository-state-forward-')
        const reverseRoot = await createTempDirectory('debate-repository-state-reverse-')
        const forward = new DebateRepository(forwardRoot)
        const reverse = new DebateRepository(reverseRoot)
        await forward.saveSession(left)
        await forward.saveSession(right)
        await reverse.saveSession(right)
        await reverse.saveSession(left)

        expect((await forward.get('session-1'))?.state).toBe(expected)
        expect((await reverse.get('session-1'))?.state).toBe(expected)
      }
    }
  }, 30_000)

  it('uses progress and a canonical final tie-break for same-state same-instant snapshots', async () => {
    const timestamp = '2026-08-11T10:00:00Z'
    const lessProgress = createSession({ state: 'running', currentTurn: 1, updatedAt: timestamp })
    const moreProgress = createSession({ state: 'running', currentTurn: 2, updatedAt: timestamp })
    await expectOrderIndependentWinner(lessProgress, moreProgress, moreProgress)

    const fewerMessages = createSession({ state: 'running', updatedAt: timestamp })
    const moreMessages = createSession({
      state: 'running',
      updatedAt: timestamp,
      messages: [
        {
          id: 'message-1',
          turn: 1,
          roleId: 'role-a',
          provider: 'openai',
          model: 'gpt-5',
          speech: '观点',
          status: 'continue',
          createdAt: timestamp
        }
      ]
    })
    await expectOrderIndependentWinner(fewerMessages, moreMessages, moreMessages)

    const fewerEvents = createSession({ state: 'running', updatedAt: timestamp })
    const moreEvents = createSession({
      state: 'running',
      updatedAt: timestamp,
      events: [
        {
          id: 'event-1',
          sessionId: 'session-1',
          createdAt: timestamp,
          type: 'state-changed',
          state: 'running'
        }
      ]
    })
    await expectOrderIndependentWinner(fewerEvents, moreEvents, moreEvents)

    const canonicalA = createSession({
      state: 'running',
      updatedAt: timestamp,
      setup: { ...createSession().setup, topic: 'A' }
    })
    const canonicalB = createSession({
      state: 'running',
      updatedAt: timestamp,
      setup: { ...createSession().setup, topic: 'B' }
    })
    await expectOrderIndependentWinner(canonicalA, canonicalB, canonicalB)
  })

  it('uses progress before canonical state differences for same-instant nonterminal snapshots', async () => {
    const timestamp = '2026-08-11T10:00:00Z'
    const advancedRunning = createSession({
      state: 'running',
      currentTurn: 4,
      updatedAt: timestamp
    })
    const lessAdvancedPaused = createSession({
      state: 'paused',
      currentTurn: 2,
      updatedAt: timestamp
    })

    await expectOrderIndependentWinner(advancedRunning, lessAdvancedPaused, advancedRunning)
  })
})

const writeExternalSession = async (root: string, index: number): Promise<void> => {
  const id = `external-${index.toString().padStart(5, '0')}`
  const session = createSession({ id })
  await writeFile(join(root, `debates/${id}.json`), `${JSON.stringify(session)}\n`)
}

const writeExternalSessions = async (root: string, count: number): Promise<void> => {
  await mkdir(join(root, 'debates'), { recursive: true })
  for (let start = 0; start < count; start += 250) {
    await Promise.all(
      Array.from({ length: Math.min(250, count - start) }, (_, offset) =>
        writeExternalSession(root, start + offset)
      )
    )
  }
}

const expectOrderIndependentWinner = async (
  left: DebateSession,
  right: DebateSession,
  expected: DebateSession
): Promise<void> => {
  const forwardRoot = await createTempDirectory('debate-repository-tie-forward-')
  const reverseRoot = await createTempDirectory('debate-repository-tie-reverse-')
  const forward = new DebateRepository(forwardRoot)
  const reverse = new DebateRepository(reverseRoot)
  await forward.saveSession(left)
  await forward.saveSession(right)
  await reverse.saveSession(right)
  await reverse.saveSession(left)
  expect(await forward.get(left.id)).toEqual(expected)
  expect(await reverse.get(left.id)).toEqual(expected)
}
