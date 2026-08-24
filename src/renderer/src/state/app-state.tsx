import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import type {
  ModelCapability,
  Provider,
  ProviderCapabilities,
  RoleConfig,
  RoleId,
  SamplingParameter
} from '../../../shared/domain'
import { baseUrlSchema, roleConfigSchema } from '../../../shared/schemas'

export type ConnectionState = 'idle' | 'testing' | 'passed' | 'failed'

export interface RoleDraft {
  roleId: RoleId
  name: string
  personaOrStance: string
  provider: Provider
  baseUrl: string
  model: string
  effort: string
  thinking?: boolean
  thinkingKeep?: 'none' | 'all'
  maxOutputTokens: number
  sampling: Partial<Record<SamplingParameter, number>>
  capabilities?: ProviderCapabilities
  connection: ConnectionState
  busy: boolean
  error?: string
  hasStoredSecret: boolean
}

const providerDefaults: Record<Provider, Pick<RoleDraft, 'baseUrl' | 'maxOutputTokens'>> = {
  openai: { baseUrl: '', maxOutputTokens: 4096 },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', maxOutputTokens: 4096 },
  deepseek: { baseUrl: 'https://api.deepseek.com', maxOutputTokens: 4096 }
}

function emptyDraft(roleId: RoleId): RoleDraft {
  return {
    roleId,
    name: roleId === 'role-a' ? '辩手 A' : '辩手 B',
    personaOrStance: '',
    provider: 'openai',
    ...providerDefaults.openai,
    model: '',
    effort: 'none',
    sampling: {},
    connection: 'idle',
    busy: false,
    hasStoredSecret: false
  }
}

function fromRole(role: RoleConfig): RoleDraft {
  const maxOutputTokens = role.provider === 'kimi'
    ? role.maxCompletionTokens
    : role.provider === 'deepseek' ? role.maxTokens : 4096
  return {
    ...emptyDraft(role.roleId),
    ...role,
    baseUrl: role.provider === 'openai' ? '' : role.baseUrl,
    maxOutputTokens,
    sampling: role.provider === 'openai' ? {} : (role.sampling ?? {}),
    thinking: role.provider === 'openai' ? undefined : role.thinking,
    thinkingKeep: role.provider === 'kimi' ? role.thinkingKeep : undefined,
    effort: role.effort ?? 'none',
    hasStoredSecret: role.provider !== 'openai'
  }
}

export function toRoleConfig(draft: RoleDraft): RoleConfig | undefined {
  const common = {
    roleId: draft.roleId,
    name: draft.name,
    personaOrStance: draft.personaOrStance,
    model: draft.model
  }
  const sampling = Object.keys(draft.sampling).length === 0 ? undefined : draft.sampling
  const candidate = draft.provider === 'openai'
    ? { ...common, provider: 'openai', effort: draft.effort }
    : draft.provider === 'kimi'
      ? {
          ...common, provider: 'kimi', baseUrl: draft.baseUrl,
          ...(draft.thinking === undefined ? {} : { thinking: draft.thinking }),
          ...(draft.thinkingKeep === undefined ? {} : { thinkingKeep: draft.thinkingKeep }),
          ...(draft.effort === 'none' ? {} : { effort: draft.effort }),
          maxCompletionTokens: draft.maxOutputTokens,
          ...(sampling === undefined ? {} : { sampling })
        }
      : {
          ...common, provider: 'deepseek', baseUrl: draft.baseUrl,
          ...(draft.thinking === undefined ? {} : { thinking: draft.thinking }),
          ...(draft.effort === 'none' ? {} : { effort: draft.effort }),
          maxTokens: draft.maxOutputTokens,
          ...(sampling === undefined ? {} : { sampling })
        }
  const parsed = roleConfigSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

interface AppStateValue {
  roles: Record<RoleId, RoleDraft>
  auth: { status: 'signed-out' | 'signing-in' | 'signed-in'; accountLabel?: string }
  loadError?: string
  updateRole(roleId: RoleId, change: Partial<RoleDraft>): void
  switchProvider(roleId: RoleId, provider: Provider): void
  discover(roleId: RoleId, secret?: string, onSecretStored?: () => void): Promise<void>
  test(roleId: RoleId, secret: string, onSecretStored?: () => void): Promise<void>
  deleteSecret(roleId: RoleId): Promise<void>
  startLogin(): Promise<void>
  logout(): Promise<void>
  canContinue: boolean
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined)

function applyModel(draft: RoleDraft, capabilities: ProviderCapabilities): RoleDraft {
  const modelId = capabilities.defaultModel ?? capabilities.models[0]?.id ?? ''
  const model = capabilities.models.find(({ id }) => id === modelId)
  const effort = model?.defaultReasoningEffort ?? model?.reasoningEfforts[0] ?? 'none'
  const thinking = model?.thinking?.default
  const sampling = thinking === false
    ? Object.fromEntries((model?.samplingParameters ?? []).flatMap((parameter) =>
        parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))
    : {}
  return {
    ...draft,
    capabilities,
    model: modelId,
    effort,
    thinking,
    thinkingKeep: model?.thinking?.keepSupported && thinking ? 'all' : undefined,
    maxOutputTokens: model?.maxOutputTokens ?? draft.maxOutputTokens,
    sampling,
    connection: 'idle',
    error: capabilities.models.length === 0 ? '没有发现可用模型' : undefined
  }
}

export function AppStateProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [roles, setRoles] = useState<Record<RoleId, RoleDraft>>({
    'role-a': emptyDraft('role-a'), 'role-b': emptyDraft('role-b')
  })
  const [auth, setAuth] = useState<AppStateValue['auth']>({ status: 'signed-out' })
  const [loadError, setLoadError] = useState<string>()

  useEffect(() => {
    let active = true
    void Promise.all([window.aiDebates.config.listRoles(), window.aiDebates.openAI.getAuthStatus()])
      .then(([result, status]) => {
        if (!active) return
        setRoles((current) => {
          const next = { ...current }
          for (const role of result.roles) next[role.roleId] = fromRole(role)
          return next
        })
        setAuth(status)
      })
      .catch(() => { if (active) setLoadError('无法读取已保存的配置，请稍后重试') })
    const unsubscribe = window.aiDebates.openAI.onAuthChanged((status) => {
      if (active) setAuth(status)
    })
    return () => { active = false; unsubscribe() }
  }, [])

  const updateRole = useCallback((roleId: RoleId, change: Partial<RoleDraft>) => {
    setRoles((current) => ({
      ...current,
      [roleId]: { ...current[roleId], ...change, connection: 'idle', error: undefined }
    }))
  }, [])

  const switchProvider = useCallback((roleId: RoleId, provider: Provider) => {
    setRoles((current) => {
      const previous = current[roleId]
      return {
        ...current,
        [roleId]: {
          ...emptyDraft(roleId), name: previous.name, personaOrStance: previous.personaOrStance,
          provider, ...providerDefaults[provider]
        }
      }
    })
  }, [])

  const discover = useCallback(async (roleId: RoleId, secret = '', onSecretStored?: () => void) => {
    const draft = roles[roleId]
    const request = draft.provider === 'openai'
      ? { roleId, provider: 'openai' as const }
      : { roleId, provider: draft.provider, baseUrl: draft.baseUrl }
    if (draft.provider !== 'openai' && !baseUrlSchema.safeParse(draft.baseUrl).success) {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], error: '请输入有效的 HTTPS Base URL' } }))
      return
    }
    setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: true, error: undefined } }))
    let credentialStored = false
    try {
      if (draft.provider !== 'openai' && secret.trim() !== '') {
        await window.aiDebates.credentials.setProviderSecret({
          scope: { roleId, provider: draft.provider, origin: new URL(draft.baseUrl).origin },
          secret
        })
        credentialStored = true
        onSecretStored?.()
        setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], hasStoredSecret: true } }))
      }
      const found = await window.aiDebates.providers.discoverCapabilities(request)
      setRoles((current) => ({
        ...current,
        [roleId]: current[roleId].provider === found.provider
          ? { ...applyModel(current[roleId], found), busy: false }
          : current[roleId]
      }))
    } catch {
      setRoles((current) => ({
        ...current,
        [roleId]: {
          ...current[roleId], busy: false,
          error: credentialStored ? '凭据已安全保存，但获取模型失败' : '获取模型失败'
        }
      }))
    }
  }, [roles])

  const deleteSecret = useCallback(async (roleId: RoleId): Promise<void> => {
    const draft = roles[roleId]
    if (draft.provider === 'openai') return
    const parsed = baseUrlSchema.safeParse(draft.baseUrl)
    if (!parsed.success) {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], error: '请输入有效的 HTTPS Base URL' } }))
      return
    }
    try {
      await window.aiDebates.credentials.deleteProviderSecret({
        scope: { roleId, provider: draft.provider, origin: new URL(parsed.data).origin }
      })
      setRoles((current) => ({ ...current, [roleId]: {
        ...current[roleId], hasStoredSecret: false, connection: 'idle', error: undefined
      } }))
    } catch {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], error: '删除凭据失败' } }))
    }
  }, [roles])

  const test = useCallback(async (roleId: RoleId, secret: string, onSecretStored?: () => void): Promise<void> => {
    const draft = roles[roleId]
    const role = toRoleConfig(draft)
    if (role === undefined) {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], error: '请先完整填写并获取模型' } }))
      return
    }
    setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: true, connection: 'testing', error: undefined } }))
    try {
      await window.aiDebates.config.saveRole({ role })
      if (role.provider !== 'openai' && secret.trim() !== '') {
        await window.aiDebates.credentials.setProviderSecret({
          scope: { roleId, provider: role.provider, origin: new URL(role.baseUrl).origin },
          secret
        })
        onSecretStored?.()
      }
      const request = role.provider === 'openai'
        ? { roleId, provider: 'openai' as const }
        : { roleId, provider: role.provider, origin: new URL(role.baseUrl).origin }
      const result = await window.aiDebates.providers.testConnection(request)
      setRoles((current) => ({
        ...current,
        [roleId]: {
          ...(result.capabilities === undefined ? current[roleId] : applyModel(current[roleId], result.capabilities)),
          busy: false, connection: result.ok ? 'passed' : 'failed',
          hasStoredSecret: current[roleId].hasStoredSecret || secret.trim() !== '',
          error: result.ok ? undefined : (result.message ?? '连接测试失败')
        }
      }))
    } catch {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: false, connection: 'failed', error: '连接测试失败' } }))
    }
  }, [roles])

  const startLogin = useCallback(async () => {
    setAuth({ status: 'signing-in' })
    try { await window.aiDebates.openAI.startLogin() } catch { setAuth({ status: 'signed-out' }) }
  }, [])
  const logout = useCallback(async () => {
    try { await window.aiDebates.openAI.logout(); setAuth({ status: 'signed-out' }) } catch { /* status event remains authoritative */ }
  }, [])

  const canContinue = (['role-a', 'role-b'] as const).every((id) =>
    roles[id].connection === 'passed' && toRoleConfig(roles[id]) !== undefined
  )
  const value = useMemo(() => ({
    roles, auth, loadError, updateRole, switchProvider, discover, test, deleteSecret, startLogin, logout, canContinue
  }), [roles, auth, loadError, updateRole, switchProvider, discover, test, deleteSecret, startLogin, logout, canContinue])
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (value === undefined) throw new Error('useAppState must be used inside AppStateProvider')
  return value
}

export function selectedModel(draft: RoleDraft): ModelCapability | undefined {
  return draft.capabilities?.models.find(({ id }) => id === draft.model)
}
