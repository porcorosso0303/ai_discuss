import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  argumentSummaryMetadataSchema,
  argumentSummarySchema,
  debateEventSchema,
  debateReplySchema,
  debateSessionSchema,
  debateSetupSchema,
  deepSeekRoleConfigSchema,
  kimiRoleConfigSchema,
  providerCapabilitiesSchema,
  providerSchema,
  roleConfigSchema,
  roleIdSchema
} from '../../../src/shared/schemas'
import {
  IPC_EVENT_CHANNELS,
  IPC_CHANNELS,
  IPC_INVOKE_CHANNELS,
  ipcEventContracts,
  ipcInvokeContracts
} from '../../../src/shared/ipc'

const openAiRole = {
  roleId: 'role-a',
  name: '甲方',
  personaOrStance: '支持技术进步',
  provider: 'openai',
  model: 'gpt-5',
  effort: 'high'
} as const

const kimiRole = {
  roleId: 'role-b',
  name: '乙方',
  personaOrStance: '强调潜在风险',
  provider: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'kimi-k2.5',
  thinking: false,
  maxCompletionTokens: 4096
} as const

describe('schema type ownership', () => {
  it('keeps domain.ts free of handwritten object-shape types', () => {
    const domainSource = readFileSync(
      new URL('../../../src/shared/domain.ts', import.meta.url),
      'utf8'
    )

    expect(domainSource).not.toMatch(/\binterface\b/)
    expect(domainSource).toMatch(/export type \{[\s\S]*RoleConfig[\s\S]*\} from '\.\/schemas'/)
  })
})

describe('argument summary schemas', () => {
  const metadata = {
    id: 'summary-1',
    createdAt: '2026-08-12T00:00:00.000Z',
    coveredFromTurn: 1,
    coveredThroughTurn: 3,
    provider: 'fallback',
    model: 'deterministic-local',
    source: 'fallback' as const,
    summary: { claims: ['旧观点'], evidence: [], concessions: [], disputes: [] }
  }

  it('owns argument summary contracts in shared and keeps old context events compatible', () => {
    expect(argumentSummarySchema.parse(metadata.summary)).toEqual(metadata.summary)
    expect(argumentSummaryMetadataSchema.parse(metadata)).toEqual(metadata)

    const base = {
      id: 'event-1', sessionId: 'session-1', createdAt: '2026-08-12T00:00:00.000Z',
      type: 'context-compressed' as const, roleId: 'role-a' as const, throughTurn: 3
    }
    expect(debateEventSchema.parse(base)).toEqual(base)
    expect(debateEventSchema.parse({ ...base, summary: metadata })).toEqual({ ...base, summary: metadata })
  })
})

describe('role and provider schemas', () => {
  it('accepts only the two supported role ids', () => {
    expect(roleIdSchema.parse('role-a')).toBe('role-a')
    expect(roleIdSchema.parse('role-b')).toBe('role-b')
    expect(() => roleIdSchema.parse('role-c')).toThrow()
  })

  it('accepts only supported providers', () => {
    expect(providerSchema.options).toEqual(['openai', 'kimi', 'deepseek'])
    expect(() => providerSchema.parse('anthropic')).toThrow()
  })

  it('parses provider-specific non-sensitive role configurations', () => {
    expect(roleConfigSchema.parse(openAiRole)).toEqual(openAiRole)
    expect(roleConfigSchema.parse(kimiRole)).toEqual(kimiRole)
    expect(
      roleConfigSchema.parse({
        roleId: 'role-b',
        name: '审慎方',
        personaOrStance: '',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        thinking: true,
        effort: 'max',
        maxTokens: 8192
      })
    ).toMatchObject({ provider: 'deepseek', effort: 'max' })
  })

  it('uses thinking as the only thinking toggle for Kimi and DeepSeek', () => {
    const deepSeekRole = {
      roleId: 'role-b',
      name: '审慎方',
      personaOrStance: '',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      thinking: true,
      effort: 'high',
      maxTokens: 8192
    } as const

    expect(roleConfigSchema.parse({ ...kimiRole, thinking: true, sampling: undefined })).toMatchObject({
      provider: 'kimi',
      thinking: true
    })
    expect(roleConfigSchema.parse(deepSeekRole)).toMatchObject({
      ...deepSeekRole,
      baseUrl: 'https://api.deepseek.com/'
    })
    expect(() => roleConfigSchema.parse({ ...kimiRole, thinkingEnabled: true })).toThrow()
    const { thinking: _thinking, ...deepSeekWithoutThinking } = deepSeekRole
    expect(() =>
      roleConfigSchema.parse({ ...deepSeekWithoutThinking, thinkingEnabled: true })
    ).toThrow()
  })

  it('allows Kimi thinkingKeep all only while thinking is enabled', () => {
    const kimiK26Role = { ...kimiRole, model: 'kimi-k2.6', sampling: undefined }
    expect(
      roleConfigSchema.safeParse({ ...kimiK26Role, thinking: true, thinkingKeep: 'all' }).success
    ).toBe(true)
    expect(
      roleConfigSchema.safeParse({ ...kimiK26Role, thinking: false, thinkingKeep: 'none' }).success
    ).toBe(true)
    expect(roleConfigSchema.safeParse({ ...kimiRole, thinking: false }).success).toBe(
      true
    )
    expect(
      roleConfigSchema.safeParse({ ...kimiK26Role, thinking: false, thinkingKeep: 'all' }).success
    ).toBe(false)
  })

  it('models current Kimi K3 reasoning controls without legacy thinking or sampling', () => {
    const { thinking: _thinking, ...withoutThinking } = kimiRole
    const valid = { ...withoutThinking, model: 'kimi-k3', effort: 'high' as const }

    expect(roleConfigSchema.safeParse(valid).success).toBe(true)
    expect(roleConfigSchema.safeParse({ ...valid, thinking: true }).success).toBe(false)
    expect(roleConfigSchema.safeParse({ ...valid, thinkingKeep: 'all' }).success).toBe(false)
    expect(
      roleConfigSchema.safeParse({ ...valid, sampling: { temperature: 1 } }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({ ...valid, maxCompletionTokens: 1_048_577 }).success
    ).toBe(false)
  })

  it('rejects invalid current Kimi K2.6 and K2.7 reasoning combinations', () => {
    const common = {
      roleId: 'role-b',
      name: '乙方',
      personaOrStance: '',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      maxCompletionTokens: 4096
    } as const

    expect(
      roleConfigSchema.safeParse({
        ...common,
        model: 'kimi-k2.6',
        thinking: true,
        thinkingKeep: 'all'
      }).success
    ).toBe(true)
    expect(
      roleConfigSchema.safeParse({
        ...common,
        model: 'kimi-k2.6',
        thinking: false,
        sampling: { temperature: 0.4 }
      }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({
        ...common,
        model: 'kimi-k2.6',
        effort: 'high'
      }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({
        ...common,
        model: 'kimi-k2.6',
        thinking: true,
        sampling: { topP: 0.9 }
      }).success
    ).toBe(false)

    expect(
      roleConfigSchema.safeParse({ ...common, model: 'kimi-k2.7-code' }).success
    ).toBe(true)
    for (const invalid of [
      { thinking: false },
      { effort: 'high' },
      { thinkingKeep: 'none' },
      { sampling: { presencePenalty: 0 } }
    ]) {
      expect(
        roleConfigSchema.safeParse({ ...common, model: 'kimi-k2.7-code', ...invalid }).success
      ).toBe(false)
    }
  })

  it('rejects every preserved-thinking setting for Kimi K2.5', () => {
    for (const thinkingKeep of ['none', 'all'] as const) {
      expect(
        roleConfigSchema.safeParse({ ...kimiRole, thinkingKeep }).success
      ).toBe(false)
    }
  })

  it('models current DeepSeek V4 reasoning controls and output limit', () => {
    const baseDeepSeekRole = {
      roleId: 'role-b',
      name: '乙方',
      personaOrStance: '',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTokens: 8192
    } as const

    expect(
      roleConfigSchema.safeParse({ ...baseDeepSeekRole, effort: 'low' }).success
    ).toBe(true)
    expect(roleConfigSchema.safeParse({ ...baseDeepSeekRole, effort: 'high' }).success).toBe(true)
    expect(roleConfigSchema.safeParse({ ...baseDeepSeekRole, effort: 'max' }).success).toBe(true)
    for (const effort of ['none', 'minimal', 'medium', 'xhigh']) {
      expect(roleConfigSchema.safeParse({ ...baseDeepSeekRole, effort }).success).toBe(false)
    }
    expect(
      roleConfigSchema.safeParse({ ...baseDeepSeekRole, maxTokens: 384_000 }).success
    ).toBe(true)
    expect(
      roleConfigSchema.safeParse({ ...baseDeepSeekRole, maxTokens: 384_001 }).success
    ).toBe(false)
  })

  it('allows minimal custom DeepSeek config and gates sampling on explicit non-thinking mode', () => {
    const baseDeepSeekRole = {
      roleId: 'role-b',
      name: '乙方',
      personaOrStance: '',
      provider: 'deepseek',
      baseUrl: 'https://compatible.example.test/v1',
      model: 'custom-chat-model',
      maxTokens: 8192
    } as const

    expect(roleConfigSchema.safeParse(baseDeepSeekRole).success).toBe(true)
    expect(
      roleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        thinking: false,
        sampling: { temperature: 1 }
      }).success
    ).toBe(true)
    expect(
      roleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        thinking: undefined,
        effort: 'high',
        sampling: { temperature: 1 }
      }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({ ...baseDeepSeekRole, thinking: false, effort: 'high' }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        sampling: { temperature: 1 }
      }).success
    ).toBe(false)
    expect(
      roleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        thinking: false,
        sampling: { temperature: 0.4, topP: 0.8 }
      }).success
    ).toBe(true)
    expect(
      deepSeekRoleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        thinking: false,
        sampling: { frequencyPenalty: 1 }
      }).success
    ).toBe(false)
    expect(
      deepSeekRoleConfigSchema.safeParse({
        ...baseDeepSeekRole,
        thinking: false,
        sampling: { presencePenalty: 1 }
      }).success
    ).toBe(false)
  })

  it('rejects apiKey instead of silently stripping it', () => {
    expect(() =>
      roleConfigSchema.parse({ ...kimiRole, apiKey: 'should-never-persist' })
    ).toThrow()
  })

  it('rejects unknown top-level and sampling fields at external boundaries', () => {
    expect(() => roleConfigSchema.parse({ ...openAiRole, endpoint: 'https://evil.test' })).toThrow()
    expect(() =>
      roleConfigSchema.parse({
        ...kimiRole,
        sampling: { temperature: 0.3, arbitraryParameter: 1 }
      })
    ).toThrow()
  })

  it('rejects provider fields belonging to a different provider', () => {
    expect(() =>
      roleConfigSchema.parse({
        ...openAiRole,
        baseUrl: 'https://api.openai.com/v1'
      })
    ).toThrow()
  })

  it('accepts only HTTP(S) API base URLs', () => {
    expect(() => roleConfigSchema.parse({ ...kimiRole, baseUrl: 'file:///tmp/models' })).toThrow()
  })

  it('returns validation failures without throwing for every invalid base URL', () => {
    const baseUrlSchema = kimiRoleConfigSchema.shape.baseUrl

    for (const invalidUrl of ['', 'not a url', 'file:///tmp/models']) {
      let result: ReturnType<typeof baseUrlSchema.safeParse> | undefined

      expect(() => {
        result = baseUrlSchema.safeParse(invalidUrl)
      }).not.toThrow()
      expect(result?.success).toBe(false)
    }
  })

  it('allows secure remote URLs and exact loopback HTTP URLs only', () => {
    const baseUrlSchema = kimiRoleConfigSchema.shape.baseUrl

    expect(baseUrlSchema.parse('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1'
    )
    expect(baseUrlSchema.parse('http://localhost:8080/v1')).toBe(
      'http://localhost:8080/v1'
    )
    expect(baseUrlSchema.parse('http://127.0.0.1/v1')).toBe('http://127.0.0.1/v1')
    expect(baseUrlSchema.parse('http://[::1]:8080/v1')).toBe('http://[::1]:8080/v1')

    for (const rejectedUrl of [
      'http://api.example.com/v1',
      'http://localhost.example.com/v1',
      'http://127.1/v1',
      'http://2130706433/v1',
      'https://user:password@api.example.com/v1',
      'https://api.example.com/v1?token=secret',
      'https://api.example.com/v1#credentials',
      'https://api.example.com/v1?',
      'https://api.example.com/v1#'
    ]) {
      expect(baseUrlSchema.safeParse(rejectedUrl).success).toBe(false)
    }
  })
})

describe('debate contracts', () => {
  it('defaults to 100 turns for a complete A/B setup', () => {
    expect(
      debateSetupSchema.parse({
        topic: '人工智能是否会提高整体就业质量？',
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-a'
      }).maxTurns
    ).toBe(100)
  })

  it('rejects an empty topic and more than 100 turns', () => {
    expect(() =>
      debateSetupSchema.parse({
        topic: '   ',
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-a'
      })
    ).toThrow()
    expect(() =>
      debateSetupSchema.parse({
        topic: '测试',
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-a',
        maxTurns: 101
      })
    ).toThrow()
  })

  it('rejects duplicate or incomplete role sets', () => {
    expect(() =>
      debateSetupSchema.parse({
        topic: '测试',
        roles: [openAiRole, { ...openAiRole, name: '另一个甲方' }],
        firstSpeaker: 'role-a'
      })
    ).toThrow()
  })

  it('rejects a first speaker outside the configured roles', () => {
    expect(() =>
      debateSetupSchema.parse({
        topic: '测试',
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-c'
      })
    ).toThrow()
  })

  it('parses non-empty replies with only supported statuses', () => {
    expect(debateReplySchema.parse({ speech: '我不同意这个结论。', status: 'continue' })).toEqual({
      speech: '我不同意这个结论。',
      status: 'continue'
    })
    expect(() => debateReplySchema.parse({ speech: '', status: 'continue' })).toThrow()
    expect(() => debateReplySchema.parse({ speech: '结束', status: 'win' })).toThrow()
  })

  it('round-trips a persisted session and its renderer event', () => {
    const createdAt = '2026-08-11T10:00:00.000Z'
    const event = {
      id: 'event-1',
      sessionId: 'session-1',
      createdAt,
      type: 'state-changed',
      state: 'running'
    } as const
    const session = {
      id: 'session-1',
      setup: {
        topic: '测试持久化往返',
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-a',
        maxTurns: 100
      },
      state: 'running',
      messages: [],
      events: [event],
      currentTurn: 0,
      createdAt,
      updatedAt: createdAt,
      contextCompressed: false
    } as const

    expect(debateEventSchema.parse(event)).toEqual(event)
    expect(debateSessionSchema.parse(session)).toEqual(session)
    expect(ipcEventContracts[IPC_CHANNELS.debateEvent].parse(event)).toEqual(event)
  })
})

describe('provider capability schema', () => {
  it('expresses dynamic per-model reasoning, context, and output capabilities', () => {
    const capabilities = {
      provider: 'openai',
      defaultModel: 'gpt-5',
      models: [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          reasoningEfforts: ['low', 'medium', 'high'],
          contextLength: 200_000,
          maxOutputTokens: 32_000,
          thinking: { default: true, keepSupported: false },
          samplingParameters: [],
          structuredOutputModes: ['json-schema']
        }
      ]
    }

    expect(providerCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
  })

  it('rejects unknown capability fields', () => {
    expect(() =>
      providerCapabilitiesSchema.parse({
        provider: 'kimi',
        models: [],
        rawProviderPayload: { secret: true }
      })
    ).toThrow()
  })

  it('rejects invalid ranges, duplicate capabilities, and unknown default models', () => {
    const model = {
      id: 'model-a',
      reasoningEfforts: ['high'],
      thinking: null,
      samplingParameters: [{ name: 'temperature', min: 0, max: 2, default: 1 }],
      structuredOutputModes: ['json-object']
    } as const

    expect(() =>
      providerCapabilitiesSchema.parse({
        provider: 'deepseek',
        defaultModel: 'missing-model',
        models: [model]
      })
    ).toThrow()
    expect(() =>
      providerCapabilitiesSchema.parse({
        provider: 'deepseek',
        models: [model, model]
      })
    ).toThrow()
    const invalidModels = [
      { ...model, reasoningEfforts: ['high', 'high'] },
      { ...model, samplingParameters: [{ name: 'temperature', min: 2, max: 1 }] },
      {
        ...model,
        samplingParameters: [{ name: 'temperature', min: 0, max: 2, default: 3 }]
      },
      {
        ...model,
        samplingParameters: [
          { name: 'temperature', min: 0, max: 2 },
          { name: 'temperature', min: 0, max: 2 }
        ]
      },
      { ...model, structuredOutputModes: ['json-object', 'json-object'] }
    ]

    for (const invalidModel of invalidModels) {
      expect(
        providerCapabilitiesSchema.safeParse({ provider: 'deepseek', models: [invalidModel] })
          .success
      ).toBe(false)
    }
  })

  it('limits provider model discovery results to 200 unique models', () => {
    const models = Array.from({ length: 201 }, (_, index) => ({
      id: `model-${index}`,
      reasoningEfforts: [],
      thinking: null,
      samplingParameters: [],
      structuredOutputModes: []
    }))

    expect(providerCapabilitiesSchema.safeParse({ provider: 'kimi', models }).success).toBe(false)
  })
})

describe('IPC contracts', () => {
  it('derives frozen invoke and event channel lists from their contract maps', () => {
    expect(Object.isFrozen(IPC_INVOKE_CHANNELS)).toBe(true)
    expect(Object.isFrozen(IPC_EVENT_CHANNELS)).toBe(true)
    expect(new Set(IPC_INVOKE_CHANNELS)).toEqual(new Set(Object.keys(ipcInvokeContracts)))
    expect(new Set(IPC_EVENT_CHANNELS)).toEqual(new Set(Object.keys(ipcEventContracts)))
  })

  it('never declares a secret field in any IPC response schema', () => {
    for (const contract of Object.values(ipcInvokeContracts)) {
      expect(JSON.stringify(z.toJSONSchema(contract.response, { io: 'input' }))).not.toMatch(
        /"secret"/i
      )
    }
  })

  it('exposes a finite whitelist without generic URL, path, command, or secret getters', () => {
    expect(new Set(IPC_INVOKE_CHANNELS).size).toBe(IPC_INVOKE_CHANNELS.length)
    expect(IPC_INVOKE_CHANNELS).toContain(IPC_CHANNELS.credentialsSetProviderSecret)

    for (const channel of IPC_INVOKE_CHANNELS) {
      expect(channel).not.toMatch(/(?:open-url|read-path|run-command|api-key:get|secret:get)/)
      expect(ipcInvokeContracts[channel]).toBeDefined()
    }
  })

  it('accepts a provider secret only on the dedicated write-only command', () => {
    const contract = ipcInvokeContracts[IPC_CHANNELS.credentialsSetProviderSecret]

    const scope = {
      roleId: 'role-b',
      provider: 'kimi',
      origin: 'https://api.moonshot.cn'
    } as const

    expect(
      contract.request.parse({
        scope,
        secret: 'sk-secret'
      })
    ).toEqual({ scope, secret: 'sk-secret' })
    expect(contract.response.parse({ stored: true })).toEqual({ stored: true })
    expect(() => contract.response.parse({ stored: true, secret: 'sk-secret' })).toThrow()
  })

  it('scopes credential set, delete, and connection checks to role, provider, and origin', () => {
    const moonshotScope = {
      roleId: 'role-b',
      provider: 'kimi',
      origin: 'https://api.moonshot.cn'
    } as const
    const compatibleScope = {
      ...moonshotScope,
      origin: 'https://compatible.example.com'
    } as const

    const setContract = ipcInvokeContracts[IPC_CHANNELS.credentialsSetProviderSecret]
    const deleteContract = ipcInvokeContracts[IPC_CHANNELS.credentialsDeleteProviderSecret]
    const connectionContract = ipcInvokeContracts[IPC_CHANNELS.providerTestConnection]

    expect(setContract.request.parse({ scope: moonshotScope, secret: 'first' }).scope).not.toEqual(
      setContract.request.parse({ scope: compatibleScope, secret: 'second' }).scope
    )
    expect(deleteContract.request.parse({ scope: moonshotScope })).toEqual({ scope: moonshotScope })
    expect(connectionContract.request.parse(compatibleScope)).toEqual(compatibleScope)
  })

  it('uses strict provider-specific connection test requests', () => {
    const contract = ipcInvokeContracts[IPC_CHANNELS.providerTestConnection]

    expect(contract.request.parse({ roleId: 'role-a', provider: 'openai' })).toEqual({
      roleId: 'role-a',
      provider: 'openai'
    })
    expect(
      contract.request.safeParse({
        roleId: 'role-a',
        provider: 'openai',
        origin: 'https://api.openai.com'
      }).success
    ).toBe(false)
    expect(
      contract.request.safeParse({
        roleId: 'role-a',
        provider: 'openai',
        secret: 'must-not-cross-this-boundary'
      }).success
    ).toBe(false)

    expect(
      contract.request.parse({
        roleId: 'role-b',
        provider: 'kimi',
        origin: 'https://api.moonshot.cn:443/v1'
      })
    ).toEqual({ roleId: 'role-b', provider: 'kimi', origin: 'https://api.moonshot.cn' })
    expect(
      contract.request.parse({
        roleId: 'role-b',
        provider: 'deepseek',
        origin: 'https://api.deepseek.com'
      })
    ).toEqual({ roleId: 'role-b', provider: 'deepseek', origin: 'https://api.deepseek.com' })
    expect(contract.request.safeParse({ roleId: 'role-b', provider: 'kimi' }).success).toBe(false)
    expect(contract.request.safeParse({ roleId: 'role-b', provider: 'deepseek' }).success).toBe(
      false
    )
  })

  it('uses strict request objects for renderer input', () => {
    const contract = ipcInvokeContracts[IPC_CHANNELS.debateStart]
    const setup = {
      topic: '测试严格 IPC',
      roles: [openAiRole, kimiRole],
      firstSpeaker: 'role-a'
    }

    expect(() => contract.request.parse({ setup, command: 'whoami' })).toThrow()
  })

  it('limits renderer-controlled strings', () => {
    const scope = {
      roleId: 'role-b',
      provider: 'kimi',
      origin: 'https://api.moonshot.cn'
    } as const

    expect(roleConfigSchema.safeParse({ ...openAiRole, name: '甲'.repeat(101) }).success).toBe(
      false
    )
    expect(
      roleConfigSchema.safeParse({ ...openAiRole, personaOrStance: '甲'.repeat(4001) }).success
    ).toBe(false)
    expect(roleConfigSchema.safeParse({ ...openAiRole, model: 'm'.repeat(201) }).success).toBe(
      false
    )
    expect(
      debateSetupSchema.safeParse({
        topic: '题'.repeat(10_001),
        roles: [openAiRole, kimiRole],
        firstSpeaker: 'role-a'
      }).success
    ).toBe(false)
    expect(
      ipcInvokeContracts[IPC_CHANNELS.credentialsSetProviderSecret].request.safeParse({
        scope,
        secret: 's'.repeat(10_001)
      }).success
    ).toBe(false)
    expect(
      ipcInvokeContracts[IPC_CHANNELS.historyList].request.safeParse({
        search: 's'.repeat(501)
      }).success
    ).toBe(false)
  })
})
