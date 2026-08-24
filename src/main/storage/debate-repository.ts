import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { debateSessionSummarySchema } from '../../shared/ipc'
import {
  debateSessionSchema,
  type DebateSession
} from '../../shared/schemas'
import { AtomicJsonStore, parseSafeJson } from './atomic-json'
import { DirectoryIdentityGuard } from './directory-identity'
import { runKeyedTransaction } from './transaction-coordinator'

const INDEX_PATH = 'debates/index.json'
const MAX_RESULTS = 200
const MAX_SCANNED_SESSIONS = 5_000
const TERMINAL_STATES = new Set<DebateSession['state']>([
  'completed',
  'stopped',
  'unresolved',
  'refused',
  'failed'
])

const safeSessionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9_-])?$/, 'unsafe session id')
  .refine((id) => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id), {
    message: 'reserved Windows session id'
  })

const persistedSessionSchema = debateSessionSchema.superRefine(({ id }, context) => {
  const result = safeSessionIdSchema.safeParse(id)
  if (!result.success) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'session id is not filename-safe' })
  }
})

const historyIndexSchema = z.strictObject({
  sessions: z.array(debateSessionSummarySchema).max(MAX_RESULTS)
})

export type DebateSessionSummary = z.output<typeof debateSessionSummarySchema>

export interface DebateListOptions {
  search?: string
  limit?: number
}

export interface DebateRecoveryCandidate {
  session: DebateSession
  requiresUserResume: true
}

const summaryOf = (session: DebateSession): DebateSessionSummary => ({
  id: session.id,
  topic: session.setup.topic,
  state: session.state,
  currentTurn: session.currentTurn,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt
})

const newestFirst = (left: DebateSession, right: DebateSession): number =>
  right.updatedAt.localeCompare(left.updatedAt) ||
  right.createdAt.localeCompare(left.createdAt) ||
  left.id.localeCompare(right.id)

const normalizedSearchText = (session: DebateSession): string =>
  [
    session.setup.topic,
    ...session.setup.roles.flatMap((role) => [role.name, role.provider, role.model]),
    ...session.messages.map(({ speech }) => speech)
  ]
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

export class DebateRepository {
  private readonly root: string
  private readonly store: AtomicJsonStore

  constructor(root: string) {
    if (!isAbsolute(root)) throw new TypeError('Debate repository root must be absolute')
    this.root = resolve(root)
    this.store = new AtomicJsonStore(this.root)
  }

  async saveSession(value: DebateSession): Promise<void> {
    const session = parseSafeJson(persistedSessionSchema, value)
    await this.serialized(async () => {
      const existing = await this.readSession(session.id)
      if (
        existing !== null &&
        ((TERMINAL_STATES.has(existing.state) && !TERMINAL_STATES.has(session.state)) ||
          existing.updatedAt > session.updatedAt)
      ) {
        return
      }
      await this.store.write(this.sessionPath(session.id), persistedSessionSchema, session)
      await this.rebuildIndex()
    })
  }

  async list(options: DebateListOptions = {}): Promise<DebateSessionSummary[]> {
    const search = parseSafeJson(z.string().max(500), options.search ?? '')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .trim()
    const limit = parseSafeJson(z.number().int().min(1).max(MAX_RESULTS), options.limit ?? 50)
    return await this.serialized(async () => {
      const sessions = await this.scanSessions()
      await this.writeIndex(sessions).catch(() => undefined)
      const terms = search.split(/\s+/u).filter(Boolean)
      return sessions
        .filter((session) => {
          const haystack = normalizedSearchText(session)
          return terms.every((term) => haystack.includes(term))
        })
        .slice(0, limit)
        .map(summaryOf)
    })
  }

  async get(value: unknown): Promise<DebateSession | null> {
    const id = parseSafeJson(safeSessionIdSchema, value)
    return await this.serialized(async () => {
      const session = await this.readSession(id)
      return session === null ? null : structuredClone(session)
    })
  }

  async getRecoveryCandidate(value: unknown): Promise<DebateRecoveryCandidate | null> {
    const session = await this.get(value)
    if (session === null || TERMINAL_STATES.has(session.state)) return null
    return { session, requiresUserResume: true }
  }

  async delete(value: unknown): Promise<boolean> {
    const id = parseSafeJson(safeSessionIdSchema, value)
    return await this.serialized(async () => {
      const deleted = await this.store.delete(this.sessionPath(id))
      if (deleted) await this.rebuildIndex()
      return deleted
    })
  }

  async clear(): Promise<number> {
    return await this.serialized(async () => {
      const files = await this.listSessionFileNames()
      let deletedCount = 0
      for (const file of files) {
        if (await this.store.delete(`debates/${file}`)) deletedCount += 1
      }
      await this.writeIndex([])
      return deletedCount
    })
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    return await runKeyedTransaction(this.root, 'debate-repository', operation)
  }

  private sessionPath(id: string): string {
    return `debates/${id}.json`
  }

  private async readSession(id: string): Promise<DebateSession | null> {
    const session = await this.store.read(this.sessionPath(id), persistedSessionSchema)
    if (session !== null && session.id !== id) throw new TypeError('Session file id mismatch')
    return session
  }

  private async listSessionFileNames(): Promise<string[]> {
    const directory = join(this.root, 'debates')
    try {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new TypeError('Debates path must be a non-symlink directory')
      }
      const guard = await DirectoryIdentityGuard.capture(directory, { anchor: this.root })
      await guard.before('before-directory-open', directory)
      const entries = await readdir(directory)
      await guard.after()
      return entries
        .filter((name) => name !== 'index.json' && name.endsWith('.json'))
        .sort()
        .slice(0, MAX_SCANNED_SESSIONS)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  private async scanSessions(): Promise<DebateSession[]> {
    const sessions: DebateSession[] = []
    for (const file of await this.listSessionFileNames()) {
      const id = file.slice(0, -'.json'.length)
      if (!safeSessionIdSchema.safeParse(id).success) continue
      try {
        const session = await this.readSession(id)
        if (session !== null) sessions.push(session)
      } catch {
        // A corrupt entry is isolated; valid session files remain the source of truth.
      }
    }
    return sessions.sort(newestFirst)
  }

  private async rebuildIndex(): Promise<void> {
    await this.writeIndex(await this.scanSessions())
  }

  private async writeIndex(sessions: DebateSession[]): Promise<void> {
    await this.store.write(INDEX_PATH, historyIndexSchema, {
      sessions: sessions.slice(0, MAX_RESULTS).map(summaryOf)
    })
  }
}
