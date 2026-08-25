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
  attempt: number
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
  startRejected: boolean
  hasStartedSession: boolean
  ignoredSessionIds: ReadonlySet<string>
  seenEventIds: ReadonlySet<string>
  completedTurns: ReadonlySet<string>
  contentRevision: number
  recovered: boolean
  recoveryResumePending: boolean
  recoveryValidationFailed: boolean
}

export type DebateViewAction =
  | { type: 'begin'; setup: DebateSetup; attempt: number }
  | { type: 'event'; event: DebateEvent }
  | { type: 'session'; session: DebateSession; attempt: number }
  | { type: 'start-error'; message: string; attempt: number }
  | { type: 'discard-drafts' }
  | { type: 'recovery-resume-requested' }
  | { type: 'recovery-resume-rejected' }

const terminalStates: ReadonlySet<DebateSessionState> = new Set([
  'completed', 'stopped', 'unresolved', 'refused', 'failed'
])

const turnKey = (roleId: RoleId, turn: number): string => `${roleId}:${turn}`

export function createDebateViewState(initialSession?: DebateSession): DebateViewState {
  const empty: DebateViewState = {
    attempt: 0, phase: 'starting', currentTurn: 0, messages: [], drafts: {}, warnings: [],
    compressedRoles: [], usage: {}, startRejected: false, hasStartedSession: false,
    ignoredSessionIds: new Set(), seenEventIds: new Set(), completedTurns: new Set(), contentRevision: 0,
    recovered: false, recoveryResumePending: false, recoveryValidationFailed: false
  }
  return initialSession === undefined ? empty : restoreViewState(empty, initialSession)
}

function restoreViewState(empty: DebateViewState, session: DebateSession): DebateViewState {
  const warnings: DebateWarning[] = []
  const compressedRoles: RoleId[] = []
  const usage: Partial<Record<RoleId, Usage>> = {}
  const seenEventIds = new Set<string>()
  for (const item of session.events) {
    seenEventIds.add(item.id)
    if (item.type === 'warning') warnings.push({ id: item.id, message: item.message })
    else if (item.type === 'context-compressed' && !compressedRoles.includes(item.roleId)) {
      compressedRoles.push(item.roleId)
    } else if (item.type === 'usage-updated') usage[item.roleId] = item.usage
  }
  const completedTurns = new Set(session.messages.map(({ roleId, turn }) => turnKey(roleId, turn)))
  const nextRole = session.currentTurn % 2 === 0
    ? session.setup.firstSpeaker
    : session.setup.firstSpeaker === 'role-a' ? 'role-b' : 'role-a'
  return {
    ...empty,
    sessionId: session.id,
    setup: session.setup,
    phase: session.state,
    currentTurn: session.currentTurn,
    currentRoleId: nextRole,
    messages: session.messages,
    drafts: {},
    warnings,
    compressedRoles,
    usage,
    session,
    hasStartedSession: session.messages.length > 0 || !['idle', 'validating'].includes(session.state),
    seenEventIds,
    completedTurns,
    contentRevision: session.messages.length > 0 ? 1 : 0,
    recovered: true
  }
}

function upsertMessage(messages: DebateMessage[], message: DebateMessage): DebateMessage[] {
  const index = messages.findIndex(({ id }) => id === message.id)
  const next = index < 0 ? [...messages, message] : messages.map((item, at) => at === index ? message : item)
  return next.sort((left, right) => left.turn - right.turn || left.createdAt.localeCompare(right.createdAt))
}

function mergeSession(state: DebateViewState, session: DebateSession): DebateViewState {
  if (state.sessionId !== undefined && state.sessionId !== session.id) return state
  let next: DebateViewState = { ...state, sessionId: session.id, setup: session.setup,
    startRejected: false, error: undefined }
  for (const item of session.events) next = debateViewReducer(next, { type: 'event', event: item })
  let messages = next.messages
  const completedTurns = new Set(next.completedTurns)
  for (const message of session.messages) {
    messages = upsertMessage(messages, message)
    completedTurns.add(turnKey(message.roleId, message.turn))
  }
  return { ...next, phase: session.state, currentTurn: Math.max(next.currentTurn, session.currentTurn),
    currentRoleId: session.state === 'paused'
      ? (session.currentTurn % 2 === 0
          ? session.setup.firstSpeaker
          : session.setup.firstSpeaker === 'role-a' ? 'role-b' : 'role-a')
      : next.currentRoleId,
    hasStartedSession: next.hasStartedSession || session.messages.length > 0 ||
      !['idle', 'validating', 'failed'].includes(session.state),
    session, messages, completedTurns, drafts: terminalStates.has(session.state) ? {} : next.drafts,
    contentRevision: next.contentRevision + (session.messages.length > 0 ? 1 : 0) }
}

export function debateViewReducer(state: DebateViewState, action: DebateViewAction): DebateViewState {
  if (action.type === 'begin') {
    const ignoredSessionIds = new Set(state.ignoredSessionIds)
    if (state.sessionId !== undefined) ignoredSessionIds.add(state.sessionId)
    return { ...createDebateViewState(), attempt: action.attempt, setup: action.setup, ignoredSessionIds }
  }
  if (action.type === 'session') {
    return action.attempt === state.attempt ? mergeSession(state, action.session) : state
  }
  if (action.type === 'start-error') {
    if (action.attempt !== state.attempt) return state
    if (state.phase !== 'starting' && terminalStates.has(state.phase) && state.phase !== 'failed') return state
    if (state.phase === 'failed' && state.hasStartedSession) return state
    return { ...state, phase: 'failed', startRejected: true, drafts: {}, error: action.message,
      contentRevision: state.contentRevision + 1 }
  }
  if (action.type === 'discard-drafts') {
    return { ...state, drafts: {}, contentRevision: state.contentRevision + 1 }
  }
  if (action.type === 'recovery-resume-requested') {
    return state.recovered
      ? { ...state, recoveryResumePending: true, recoveryValidationFailed: false }
      : state
  }
  if (action.type === 'recovery-resume-rejected') {
    return { ...state, recoveryResumePending: false }
  }

  const item = action.event
  if (state.ignoredSessionIds.has(item.sessionId)) return state
  if (state.sessionId !== undefined && state.sessionId !== item.sessionId) return state
  if (state.seenEventIds.has(item.id)) return state
  const seenEventIds = new Set(state.seenEventIds).add(item.id)
  let next: DebateViewState = { ...state, sessionId: state.sessionId ?? item.sessionId, seenEventIds }

  switch (item.type) {
    case 'state-changed':
      return { ...next, phase: item.state,
        hasStartedSession: next.hasStartedSession || !['idle', 'validating', 'failed'].includes(item.state),
        drafts: terminalStates.has(item.state) ? {} : next.drafts }
    case 'turn-started':
      return { ...next, hasStartedSession: true, currentTurn: Math.max(next.currentTurn, item.turn),
        currentRoleId: item.roleId, recoveryResumePending: false }
    case 'speech-delta': {
      const key = turnKey(item.roleId, item.turn)
      if (next.completedTurns.has(key)) return next
      const previous = next.drafts[key]
      return { ...next, hasStartedSession: true, currentTurn: Math.max(next.currentTurn, item.turn), currentRoleId: item.roleId,
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
      return { ...next, hasStartedSession: true, messages: upsertMessage(next.messages, item.message), drafts,
        completedTurns: new Set(next.completedTurns).add(key), currentTurn: Math.max(next.currentTurn, item.message.turn),
        contentRevision: next.contentRevision + 1 }
    }
    case 'warning':
      return { ...next, warnings: [...next.warnings, { id: item.id, message: item.message }],
        recoveryValidationFailed: next.recoveryResumePending && item.code === 'provider-discovery-error'
          ? true : next.recoveryValidationFailed }
    case 'context-compressed':
      return { ...next, compressedRoles: next.compressedRoles.includes(item.roleId)
        ? next.compressedRoles : [...next.compressedRoles, item.roleId] }
    case 'usage-updated':
      return { ...next, usage: { ...next.usage, [item.roleId]: item.usage } }
  }
}

export function useDebateEvents(initialSession?: DebateSession): [DebateViewState, React.Dispatch<DebateViewAction>] {
  const [state, dispatch] = useReducer(debateViewReducer, initialSession, createDebateViewState)
  useEffect(() => window.aiDebates.debate.onEvent((event) => dispatch({ type: 'event', event })), [])
  return [state, dispatch]
}
