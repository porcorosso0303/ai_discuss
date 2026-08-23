import type { DebateSession, RoleConfig } from '../../src/shared/schemas'

export const openAIRole: RoleConfig = {
  roleId: 'role-a',
  provider: 'openai',
  name: '正方',
  personaOrStance: '支持该命题',
  model: 'gpt-5',
  effort: 'medium'
}

export const kimiRole: RoleConfig = {
  roleId: 'role-b',
  provider: 'kimi',
  name: '反方',
  personaOrStance: '反对该命题',
  model: 'kimi-k2.5',
  baseUrl: 'https://api.moonshot.cn/v1/',
  maxCompletionTokens: 4096
}

export const createSession = (overrides: Partial<DebateSession> = {}): DebateSession => ({
  id: 'session-1',
  setup: {
    topic: '人工智能会改善教育吗？',
    roles: [openAIRole, kimiRole],
    firstSpeaker: 'role-a',
    maxTurns: 100
  },
  state: 'paused',
  messages: [],
  events: [],
  currentTurn: 0,
  createdAt: '2026-08-11T10:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
  contextCompressed: false,
  ...overrides
})
