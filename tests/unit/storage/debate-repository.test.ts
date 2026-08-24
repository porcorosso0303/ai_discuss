import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DebateRepository } from '../../../src/main/storage/debate-repository'
import type { DebateSession } from '../../../src/shared/schemas'
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
})
