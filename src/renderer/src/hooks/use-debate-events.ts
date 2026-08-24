import { useEffect, useReducer } from 'react'

import type {
  DebateEvent,
  DebateMessage,
  DebateSession,
  DebateSessionState,
  DebateSetup,
  RoleId,
  Usage
} from '../../../shared/domain'

export interface DebateDraft {
  roleId: RoleId
  turn: number
  speech: string
}

export interface DebateWarning {
  id: string
  message: string
}

export interface DebateViewState {
  sessionId?: string
  setup?: DebateSetup
  phase: DebateSessionState | 'starting'
  currentTurn: number
  currentRoleId?: RoleId
  messages: DebateMessage[]
  drafts: Record<string, DebateDraft>
  warnings: DebateWarning[]
  compressedRoles: RoleId[]
  usage: Partial<Record<RoleId, Usage>>
  session?: DebateSession
  error?: string
  seenEventIds: ReadonlySet<string>
  completedTurns: ReadonlySet<string>
  contentRevision: number
}

export type DebateViewAction =
  | { type: 'begin'; setup: DebateSetup }
  | { type: 'event'; event: DebateEvent }
  | { type: 'session'; session: DebateSession }
  | { type: 'start-error'; message: string }
  | { type: 'discard-drafts' }

const terminalStates: ReadonlySet<DebateSessionState> = new Set([
  'completed', 'stopped', 'unresolved', 'refused', 'failed'
])

const turnKey = (roleId: RoleId, turn: number): string => `${roleId}:${turn}`

export function createDebateViewState(): DebateViewState {
  return {
    phase: 'starting', currentTurn: 0, messages: [], drafts: {}, warnings: [],
    compressedRoles: [], usage: {}, seenEventIds: new Set(), completedTurns: new Set(), contentRevision: 0
  }
}

function upsertMessage(messages: DebateMessage[], message: DebateMessage): DebateMessage[] {
  const index = messages.findIndex(({ id }) => id === message.id)
  const next = index < 0 ? [...messages, message] : messages.map((item, at) => at === index ? message : item)
  return next.sort((left, right) => left.turn - right.turn || left.createdAt.localeCompare(right.createdAt))
}

function mergeSession(state: DebateViewState, session: DebateSession): DebateViewState {
  if (state.sessionId !== undefined && state.sessionId !== session.id) return state
  let next: DebateViewState = { ...state, sessionId: session.id, setup: session.setup, error: undefined }
  for (const item of session.events) next = debateViewReducer(next, { type: 'event', event: item })
  let messages = next.messages
  const completedTurns = new Set(next.completedTurns)
  for (const message of session.messages) {
    messages = upsertMessage(messages, message)
    completedTurns.add(turnKey(message.roleId, message.turn))
  }
  return { ...next, phase: session.state, currentTurn: Math.max(next.currentTurn, session.currentTurn),
    session, messages, completedTurns, drafts: terminalStates.has(session.state) ? {} : next.drafts,
    contentRevision: next.contentRevision + (session.messages.length > 0 ? 1 : 0) }
}

export function debateViewReducer(state: DebateViewState, action: DebateViewAction): DebateViewState {
  if (action.type === 'begin') {
    return { ...createDebateViewState(), setup: action.setup }
  }
  if (action.type === 'session') return mergeSession(state, action.session)
  if (action.type === 'start-error') {
    return { ...state, phase: 'failed', drafts: {}, error: action.message, contentRevision: state.contentRevision + 1 }
  }
  if (action.type === 'discard-drafts') {
    return { ...state, drafts: {}, contentRevision: state.contentRevision + 1 }
  }

  const item = action.event
  if (state.sessionId !== undefined && state.sessionId !== item.sessionId) return state
  if (state.seenEventIds.has(item.id)) return state
  const seenEventIds = new Set(state.seenEventIds).add(item.id)
  let next: DebateViewState = { ...state, sessionId: state.sessionId ?? item.sessionId, seenEventIds }

  switch (item.type) {
    case 'state-changed':
      return { ...next, phase: item.state, drafts: terminalStates.has(item.state) ? {} : next.drafts }
    case 'turn-started':
      return { ...next, currentTurn: Math.max(next.currentTurn, item.turn), currentRoleId: item.roleId }
    case 'speech-delta': {
      const key = turnKey(item.roleId, item.turn)
      if (next.completedTurns.has(key)) return next
      const previous = next.drafts[key]
      return { ...next, currentTurn: Math.max(next.currentTurn, item.turn), currentRoleId: item.roleId,
        drafts: { ...next.drafts, [key]: { roleId: item.roleId, turn: item.turn,
          speech: `${previous?.speech ?? ''}${item.delta}` } }, contentRevision: next.contentRevision + 1 }
    }
    case 'speech-reset': {
      const drafts = { ...next.drafts }
      delete drafts[turnKey(item.roleId, item.turn)]
      return { ...next, drafts, contentRevision: next.contentRevision + 1 }
    }
    case 'message-completed': {
      const key = turnKey(item.message.roleId, item.message.turn)
      const drafts = { ...next.drafts }
      delete drafts[key]
      return { ...next, messages: upsertMessage(next.messages, item.message), drafts,
        completedTurns: new Set(next.completedTurns).add(key), currentTurn: Math.max(next.currentTurn, item.message.turn),
        contentRevision: next.contentRevision + 1 }
    }
    case 'warning':
      return { ...next, warnings: [...next.warnings, { id: item.id, message: item.message }] }
    case 'context-compressed':
      return { ...next, compressedRoles: next.compressedRoles.includes(item.roleId)
        ? next.compressedRoles : [...next.compressedRoles, item.roleId] }
    case 'usage-updated':
      return { ...next, usage: { ...next.usage, [item.roleId]: item.usage } }
  }
}

export function useDebateEvents(): [DebateViewState, React.Dispatch<DebateViewAction>] {
  const [state, dispatch] = useReducer(debateViewReducer, undefined, createDebateViewState)
  useEffect(() => window.aiDebates.debate.onEvent((event) => dispatch({ type: 'event', event })), [])
  return [state, dispatch]
}
