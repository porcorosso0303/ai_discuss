import type {
  DebateMessage,
  DebateSessionState,
  DebateSetup,
  DebateTerminationReason,
  RoleId
} from '../../shared/domain'

export interface DebateMachineState {
  sessionId: string
  setup: DebateSetup
  phase: DebateSessionState
  messages: DebateMessage[]
  turnCount: number
  currentSpeaker: RoleId
  turnInFlight: boolean
  pendingAgreementRoleId?: RoleId
  winnerRoleId?: RoleId
  terminationReason?: DebateTerminationReason
}

export type DebateMachineAction =
  | { type: 'beginValidation' }
  | { type: 'validationSucceeded' }
  | { type: 'turnStarted'; roleId: RoleId }
  | { type: 'turnCompleted'; message: DebateMessage }
  | { type: 'pauseRequested' }
  | { type: 'stopRequested' }
  | { type: 'turnFailed' }
  | { type: 'turnRefused' }
  | { type: 'retryCurrentTurn' }
  | { type: 'finishFailed' }
  | { type: 'resume' }

export interface DebateMachineTransition {
  state: DebateMachineState
  warning?: string
}

export const createDebateMachine = (
  sessionId: string,
  setup: DebateSetup
): DebateMachineState => ({
  sessionId,
  setup,
  phase: 'idle',
  messages: [],
  turnCount: 0,
  currentSpeaker: setup.firstSpeaker,
  turnInFlight: false
})

const unchanged = (
  state: DebateMachineState,
  action: DebateMachineAction,
  detail?: string
): DebateMachineTransition => ({
  state,
  warning: `Cannot apply ${action.type} while debate is ${state.phase}${detail ?? ''}`
})

const otherRole = (roleId: RoleId): RoleId => (roleId === 'role-a' ? 'role-b' : 'role-a')

export const reduceDebateState = (
  state: DebateMachineState,
  action: DebateMachineAction
): DebateMachineTransition => {
  switch (action.type) {
    case 'beginValidation':
      return state.phase === 'idle'
        ? { state: { ...state, phase: 'validating' } }
        : unchanged(state, action)

    case 'validationSucceeded':
      return state.phase === 'validating'
        ? { state: { ...state, phase: 'running' } }
        : unchanged(state, action)

    case 'turnStarted':
      if (
        state.phase !== 'running' ||
        state.turnInFlight ||
        state.turnCount >= state.setup.maxTurns
      ) {
        return unchanged(state, action)
      }

      if (action.roleId !== state.currentSpeaker) {
        return unchanged(
          state,
          action,
          `: received ${action.roleId}, expected ${state.currentSpeaker}`
        )
      }

      return { state: { ...state, turnInFlight: true } }

    case 'turnCompleted':
      if (
        (state.phase !== 'running' && state.phase !== 'pausing') ||
        !state.turnInFlight ||
        action.message.roleId !== state.currentSpeaker ||
        action.message.turn !== state.turnCount + 1
      ) {
        return unchanged(state, action)
      }

      const completed = {
        ...state,
        messages: [...state.messages, action.message],
        turnCount: state.turnCount + 1,
        turnInFlight: false
      }

      if (action.message.status === 'concede') {
        return {
          state: {
            ...completed,
            phase: 'completed',
            winnerRoleId: otherRole(action.message.roleId),
            terminationReason: 'conceded'
          }
        }
      }

      if (
        action.message.status === 'agree' &&
        state.pendingAgreementRoleId !== undefined &&
        state.pendingAgreementRoleId !== action.message.roleId
      ) {
        return {
          state: {
            ...completed,
            phase: 'completed',
            pendingAgreementRoleId: action.message.roleId,
            terminationReason: 'agreed'
          }
        }
      }

      if (completed.turnCount >= state.setup.maxTurns) {
        return {
          state: {
            ...completed,
            phase: 'unresolved',
            pendingAgreementRoleId:
              action.message.status === 'agree' ? action.message.roleId : undefined,
            terminationReason: 'max-turns'
          }
        }
      }

      return {
        state: {
          ...completed,
          phase: state.phase === 'pausing' ? 'paused' : 'running',
          currentSpeaker: otherRole(state.currentSpeaker),
          pendingAgreementRoleId:
            action.message.status === 'agree' ? action.message.roleId : undefined
        }
      }

    case 'pauseRequested':
      if (state.phase !== 'running') {
        return unchanged(state, action)
      }

      return {
        state: {
          ...state,
          phase: state.turnInFlight ? 'pausing' : 'paused'
        }
      }

    case 'stopRequested':
      if (!['validating', 'running', 'pausing', 'paused'].includes(state.phase)) {
        return unchanged(state, action)
      }

      return {
        state: {
          ...state,
          phase: 'stopped',
          turnInFlight: false,
          terminationReason: 'user-stopped'
        }
      }

    case 'turnFailed':
      if (
        (state.phase !== 'running' && state.phase !== 'pausing') ||
        !state.turnInFlight
      ) {
        return unchanged(state, action)
      }

      return {
        state: {
          ...state,
          phase: 'failed',
          turnInFlight: false,
          terminationReason: 'call-failed'
        }
      }

    case 'turnRefused':
      if (
        (state.phase !== 'running' && state.phase !== 'pausing') ||
        !state.turnInFlight
      ) {
        return unchanged(state, action)
      }

      return {
        state: {
          ...state,
          phase: 'refused',
          turnInFlight: false,
          terminationReason: 'provider-refusal'
        }
      }

    case 'retryCurrentTurn':
      if (state.phase !== 'failed') {
        return unchanged(state, action)
      }

      return {
        state: {
          ...state,
          phase: 'running',
          terminationReason: undefined
        }
      }

    case 'finishFailed':
      return state.phase === 'failed' ? { state: { ...state } } : unchanged(state, action)

    case 'resume':
      if (state.phase !== 'paused') {
        return unchanged(state, action)
      }

      return { state: { ...state, phase: 'running' } }
  }
}
