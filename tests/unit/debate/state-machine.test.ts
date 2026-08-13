import { describe, expect, it } from 'vitest'

import {
  createDebateMachine,
  reduceDebateState
} from '../../../src/main/debate/state-machine'
import type { DebateMessage, DebateSetup, RoleId } from '../../../src/shared/domain'

const setup = (firstSpeaker: RoleId = 'role-a', maxTurns = 100): DebateSetup => ({
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
  firstSpeaker,
  maxTurns
})

const message = (
  turn: number,
  roleId: RoleId,
  status: DebateMessage['status'] = 'continue'
): DebateMessage => ({
  id: `message-${turn}`,
  turn,
  roleId,
  provider: roleId === 'role-a' ? 'openai' : 'kimi',
  model: roleId === 'role-a' ? 'gpt-5' : 'kimi-k2.5',
  speech: `${roleId} 第 ${turn} 次发言`,
  status,
  createdAt: `2026-08-12T00:00:${String(turn).padStart(2, '0')}.000Z`
})

const start = (firstSpeaker: RoleId = 'role-a', maxTurns = 100) => {
  let machine = createDebateMachine('session-1', setup(firstSpeaker, maxTurns))
  machine = reduceDebateState(machine, { type: 'beginValidation' }).state
  machine = reduceDebateState(machine, { type: 'validationSucceeded' }).state
  return machine
}

describe('debate state machine basics', () => {
  it('moves through validation and starts with the configured first speaker', () => {
    let machine = createDebateMachine('session-1', setup('role-b'))

    expect(machine.phase).toBe('idle')
    expect(machine.currentSpeaker).toBe('role-b')

    machine = reduceDebateState(machine, { type: 'beginValidation' }).state
    expect(machine.phase).toBe('validating')

    machine = reduceDebateState(machine, { type: 'validationSucceeded' }).state
    expect(machine.phase).toBe('running')
    expect(machine.currentSpeaker).toBe('role-b')
  })

  it('counts only a completed message and alternates speakers', () => {
    let machine = start()

    machine = reduceDebateState(machine, {
      type: 'turnStarted',
      roleId: 'role-a'
    }).state

    expect(machine.turnCount).toBe(0)
    expect(machine.messages).toEqual([])
    expect(machine.turnInFlight).toBe(true)

    machine = reduceDebateState(machine, {
      type: 'turnCompleted',
      message: message(1, 'role-a')
    }).state

    expect(machine.turnCount).toBe(1)
    expect(machine.messages).toHaveLength(1)
    expect(machine.currentSpeaker).toBe('role-b')
    expect(machine.turnInFlight).toBe(false)
  })

  it('rejects an out-of-order speaker without changing state', () => {
    const machine = start('role-a')
    const result = reduceDebateState(machine, {
      type: 'turnStarted',
      roleId: 'role-b'
    })

    expect(result.state).toBe(machine)
    expect(result.warning).toContain('role-b')
    expect(result.warning).toContain('role-a')
  })

  it('returns an explicit warning for an illegal phase transition', () => {
    const machine = createDebateMachine('session-1', setup())
    const result = reduceDebateState(machine, { type: 'resume' })

    expect(result.state).toBe(machine)
    expect(result.warning).toContain('idle')
  })
})

const completeTurn = (
  machine: ReturnType<typeof start>,
  status: DebateMessage['status'] = 'continue'
) => {
  const roleId = machine.currentSpeaker
  const turn = machine.turnCount + 1
  const started = reduceDebateState(machine, { type: 'turnStarted', roleId }).state
  return reduceDebateState(started, {
    type: 'turnCompleted',
    message: message(turn, roleId, status)
  }).state
}

describe('debate state machine termination rules', () => {
  it('completes immediately when the current speaker concedes and names the opponent winner', () => {
    const machine = completeTurn(start('role-b'), 'concede')

    expect(machine.phase).toBe('completed')
    expect(machine.winnerRoleId).toBe('role-a')
    expect(machine.terminationReason).toBe('conceded')
    expect(machine.currentSpeaker).toBe('role-b')
  })

  it('completes only after different roles agree in consecutive completed messages', () => {
    let machine = completeTurn(start(), 'agree')

    expect(machine.phase).toBe('running')
    expect(machine.pendingAgreementRoleId).toBe('role-a')

    machine = completeTurn(machine, 'agree')

    expect(machine.phase).toBe('completed')
    expect(machine.terminationReason).toBe('agreed')
    expect(machine.winnerRoleId).toBeUndefined()
  })

  it('resets a pending agreement when the opponent continues', () => {
    let machine = completeTurn(start(), 'agree')
    machine = completeTurn(machine, 'continue')

    expect(machine.phase).toBe('running')
    expect(machine.pendingAgreementRoleId).toBeUndefined()

    machine = completeTurn(machine, 'agree')
    expect(machine.phase).toBe('running')
    expect(machine.pendingAgreementRoleId).toBe('role-a')
  })

  it('defensively refuses two completed turns from the same role as mutual agreement', () => {
    let machine = completeTurn(start(), 'agree')
    const started = reduceDebateState(machine, {
      type: 'turnStarted',
      roleId: machine.currentSpeaker
    }).state
    const forged = message(2, 'role-a', 'agree')
    const result = reduceDebateState(started, { type: 'turnCompleted', message: forged })

    expect(result.state).toBe(started)
    expect(result.state.phase).toBe('running')
    expect(result.warning).toBeDefined()
  })

  it('ends unresolved on the first completed message when maxTurns is one', () => {
    const machine = completeTurn(start('role-a', 1), 'continue')

    expect(machine.turnCount).toBe(1)
    expect(machine.phase).toBe('unresolved')
    expect(machine.terminationReason).toBe('max-turns')

    const extra = reduceDebateState(machine, { type: 'turnStarted', roleId: 'role-b' })
    expect(extra.state).toBe(machine)
    expect(extra.warning).toBeDefined()
  })

  it('permits exactly 100 completed messages and never starts message 101', () => {
    let machine = start('role-a', 100)

    for (let turn = 1; turn <= 100; turn += 1) {
      machine = completeTurn(machine)
    }

    expect(machine.turnCount).toBe(100)
    expect(machine.messages).toHaveLength(100)
    expect(machine.phase).toBe('unresolved')

    const callsBefore = machine.turnCount
    machine = reduceDebateState(machine, {
      type: 'turnStarted',
      roleId: machine.currentSpeaker
    }).state
    expect(machine.turnCount).toBe(callsBefore)
    expect(machine.turnInFlight).toBe(false)
  })

  it('gives concede and mutual agreement priority over maxTurns', () => {
    const conceded = completeTurn(start('role-a', 1), 'concede')
    expect(conceded.phase).toBe('completed')
    expect(conceded.terminationReason).toBe('conceded')

    let agreed = completeTurn(start('role-a', 2), 'agree')
    agreed = completeTurn(agreed, 'agree')
    expect(agreed.phase).toBe('completed')
    expect(agreed.terminationReason).toBe('agreed')
  })
})

describe('debate state machine controls and failures', () => {
  it('records validation failure and refuses retryCurrentTurn for that failure stage', () => {
    let machine = createDebateMachine('session-1', setup())
    machine = reduceDebateState(machine, { type: 'beginValidation' }).state
    machine = reduceDebateState(machine, { type: 'validationFailed' }).state

    expect(machine.phase).toBe('failed')
    expect(machine.failureStage).toBe('validation')
    expect(machine.terminationReason).toBe('call-failed')
    expect(machine.turnInFlight).toBe(false)

    const retry = reduceDebateState(machine, { type: 'retryCurrentTurn' })
    expect(retry.state).toBe(machine)
    expect(retry.warning).toContain('validation')
  })

  it('pauses immediately when no turn is in flight and resumes the same speaker', () => {
    const running = start('role-b')
    const paused = reduceDebateState(running, { type: 'pauseRequested' }).state

    expect(paused.phase).toBe('paused')
    expect(paused.currentSpeaker).toBe('role-b')

    const resumed = reduceDebateState(paused, { type: 'resume' }).state
    expect(resumed.phase).toBe('running')
    expect(resumed.currentSpeaker).toBe('role-b')
  })

  it('finishes an in-flight turn before pausing and resumes with the opponent', () => {
    let machine = start()
    machine = reduceDebateState(machine, { type: 'turnStarted', roleId: 'role-a' }).state
    machine = reduceDebateState(machine, { type: 'pauseRequested' }).state

    expect(machine.phase).toBe('pausing')
    expect(machine.turnInFlight).toBe(true)

    machine = reduceDebateState(machine, {
      type: 'turnCompleted',
      message: message(1, 'role-a')
    }).state

    expect(machine.phase).toBe('paused')
    expect(machine.messages).toHaveLength(1)
    expect(machine.turnCount).toBe(1)
    expect(machine.currentSpeaker).toBe('role-b')

    machine = reduceDebateState(machine, { type: 'resume' }).state
    expect(machine.phase).toBe('running')
    expect(machine.currentSpeaker).toBe('role-b')
  })

  it('stops without saving a draft and ignores a late completion', () => {
    let machine = start()
    machine = reduceDebateState(machine, { type: 'turnStarted', roleId: 'role-a' }).state
    machine = reduceDebateState(machine, { type: 'stopRequested' }).state

    expect(machine.phase).toBe('stopped')
    expect(machine.terminationReason).toBe('user-stopped')
    expect(machine.turnInFlight).toBe(false)
    expect(machine.messages).toEqual([])

    const late = reduceDebateState(machine, {
      type: 'turnCompleted',
      message: message(1, 'role-a')
    })
    expect(late.state).toBe(machine)
    expect(late.state.messages).toEqual([])
    expect(late.warning).toBeDefined()
  })

  it('enters failed without counting a turn and retries the same speaker', () => {
    let machine = start('role-b')
    machine = reduceDebateState(machine, { type: 'turnStarted', roleId: 'role-b' }).state
    machine = reduceDebateState(machine, { type: 'turnFailed' }).state

    expect(machine.phase).toBe('failed')
    expect(machine.terminationReason).toBe('call-failed')
    expect(machine.failureStage).toBe('turn')
    expect(machine.turnCount).toBe(0)
    expect(machine.messages).toEqual([])
    expect(machine.currentSpeaker).toBe('role-b')

    machine = reduceDebateState(machine, { type: 'retryCurrentTurn' }).state
    expect(machine.phase).toBe('running')
    expect(machine.terminationReason).toBeUndefined()
    expect(machine.failureStage).toBeUndefined()
    expect(machine.currentSpeaker).toBe('role-b')
  })

  it('enters refused without saving a model message', () => {
    let machine = start()
    machine = reduceDebateState(machine, { type: 'turnStarted', roleId: 'role-a' }).state
    machine = reduceDebateState(machine, { type: 'turnRefused' }).state

    expect(machine.phase).toBe('refused')
    expect(machine.terminationReason).toBe('provider-refusal')
    expect(machine.turnCount).toBe(0)
    expect(machine.messages).toEqual([])
  })
})
