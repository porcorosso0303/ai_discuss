import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  accountReadResponseSchema,
  codexErrorInfoSchema,
  modelListResponseSchema,
  itemCompletedSchema,
  itemStartedSchema,
  threadTokenUsageUpdatedSchema,
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

  it('accepts official minimal item lifecycle and token usage notification shapes', () => {
    const item = { type: 'agentMessage', id: 'message-1', text: 'answer' }
    expect(
      itemStartedSchema.parse({
        threadId: 'thread-1',
        turnId: 'turn-1',
        startedAtMs: 1,
        item
      }).item
    ).toMatchObject({ phase: null, memoryCitation: null })
    expect(
      itemCompletedSchema.parse({
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: 2,
        item
      }).item
    ).toMatchObject({ phase: null, memoryCitation: null })

    const usage = threadTokenUsageUpdatedSchema.parse({
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: {
          totalTokens: 10,
          inputTokens: 6,
          cachedInputTokens: 2,
          outputTokens: 3,
          reasoningOutputTokens: 1
        },
        last: {
          totalTokens: 10,
          inputTokens: 6,
          cachedInputTokens: 2,
          outputTokens: 3,
          reasoningOutputTokens: 1
        }
      }
    })
    expect(usage.tokenUsage.last.cacheWriteInputTokens).toBe(0)
    expect(usage.tokenUsage.modelContextWindow).toBeNull()
  })

  it('accepts omitted HTTP status and enforces the official uint16 range', () => {
    expect(
      codexErrorInfoSchema.parse({ responseStreamDisconnected: {} })
    ).toEqual({ responseStreamDisconnected: { httpStatusCode: null } })
    expect(
      codexErrorInfoSchema.safeParse({ httpConnectionFailed: { httpStatusCode: 0 } })
        .success
    ).toBe(true)
    expect(
      codexErrorInfoSchema.safeParse({ httpConnectionFailed: { httpStatusCode: 65_535 } })
        .success
    ).toBe(true)
    expect(
      codexErrorInfoSchema.safeParse({ httpConnectionFailed: { httpStatusCode: -1 } })
        .success
    ).toBe(false)
    expect(
      codexErrorInfoSchema.safeParse({ httpConnectionFailed: { httpStatusCode: 65_536 } })
        .success
    ).toBe(false)
  })

  it('vendors and relies on stable-only 0.147 artifacts', async () => {
    for (const name of [
      'ThreadStartParams.json',
      'ThreadStartResponse.json',
      'TurnStartParams.json'
    ]) {
      const source = await readFile(
        join(process.cwd(), 'vendor', 'codex-schema', 'v2', name),
        'utf8'
      )
      const schema = JSON.parse(source) as { properties?: Record<string, unknown> }
      expect(schema.properties).not.toHaveProperty('runtimeWorkspaceRoots')
      expect(schema.properties).not.toHaveProperty('activePermissionProfile')
      expect(source).not.toContain('experimentalApi')
    }
  })
})
