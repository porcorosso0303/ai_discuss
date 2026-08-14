import { describe, expect, it } from 'vitest'

import {
  accountReadResponseSchema,
  modelListResponseSchema,
  threadStartResponseSchema,
  turnCompletedSchema,
  turnStartResponseSchema
} from '../../../../src/main/providers/codex/codex-events'
import accountReadMinimal from '../../../fixtures/codex/account-read-minimal.json'
import modelListMinimal from '../../../fixtures/codex/model-list-minimal.json'
import threadAndTurnMinimal from '../../../fixtures/codex/thread-and-turn-minimal.json'

describe('Codex 0.147 stable response subsets', () => {
  it('accepts the official minimal account and model-list shapes with compatibility defaults', () => {
    expect(accountReadResponseSchema.parse(accountReadMinimal)).toEqual(accountReadMinimal)

    const parsed = modelListResponseSchema.parse(modelListMinimal)
    expect(parsed.nextCursor).toBeNull()
    expect(parsed.data[0]).toMatchObject({
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      modelSpecialty: null
    })
  })

  it('accepts official minimal thread and turn shapes and defaults read-only network off', () => {
    const thread = threadStartResponseSchema.parse(threadAndTurnMinimal.threadStart)
    expect(thread.sandbox).toEqual({ type: 'readOnly', networkAccess: false })
    expect(turnStartResponseSchema.parse(threadAndTurnMinimal.turnStart).turn.id).toBe('turn-1')
    expect(turnCompletedSchema.parse(threadAndTurnMinimal.turnCompleted).turn.status).toBe(
      'completed'
    )
  })

  it('rejects malformed known nested catalog and safety fields', () => {
    expect(
      modelListResponseSchema.safeParse({
        ...modelListMinimal,
        data: [{ ...modelListMinimal.data[0], upgradeInfo: { model: 7 } }]
      }).success
    ).toBe(false)
    expect(
      threadStartResponseSchema.safeParse({
        ...threadAndTurnMinimal.threadStart,
        sandbox: { type: 'readOnly', networkAccess: 'false' }
      }).success
    ).toBe(false)
  })
})
