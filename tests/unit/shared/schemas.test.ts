import { describe, expect, it } from 'vitest'

import {
  debateReplySchema,
  debateSetupSchema,
  providerCapabilitiesSchema,
  providerSchema,
  roleConfigSchema,
  roleIdSchema
} from '../../../src/shared/schemas'
import {
  IPC_CHANNELS,
  IPC_INVOKE_CHANNELS,
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
  thinkingEnabled: true,
  thinkingKeep: false,
  maxCompletionTokens: 4096,
  sampling: {
    temperature: 0.3,
    topP: 0.9,
    frequencyPenalty: 0,
    presencePenalty: 0
  }
} as const

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
        thinkingEnabled: true,
        effort: 'max',
        maxTokens: 8192,
        sampling: { temperature: 1, topP: 0.95 }
      })
    ).toMatchObject({ provider: 'deepseek', effort: 'max' })
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
        sampling: { ...kimiRole.sampling, arbitraryParameter: 1 }
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
})

describe('provider capability schema', () => {
  it('expresses dynamic per-model reasoning, context, and output capabilities', () => {
    const capabilities = {
      provider: 'openai',
      models: [
        {
          id: 'gpt-5',
          displayName: 'GPT-5',
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium',
          contextLength: 200_000,
          thinking: { supported: true, supportsKeep: false },
          sampling: { supported: false, parameters: [] },
          structuredOutput: { supported: true, modes: ['json-schema'] }
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
})

describe('IPC contracts', () => {
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

    expect(
      contract.request.parse({
        roleId: 'role-b',
        provider: 'kimi',
        secret: 'sk-secret'
      })
    ).toMatchObject({ provider: 'kimi' })
    expect(contract.response.parse({ stored: true })).toEqual({ stored: true })
    expect(() => contract.response.parse({ stored: true, secret: 'sk-secret' })).toThrow()
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
})
