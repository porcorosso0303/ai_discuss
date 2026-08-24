import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import type {
  CredentialScope,
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
  fieldErrors: Record<string, string>
  credentialScope?: CredentialScope
  credentialPresent: boolean
  orphanedCredentialScope?: CredentialScope
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
    credentialPresent: false,
    fieldErrors: {}
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
    credentialPresent: false
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

function zodFieldErrors(draft: RoleDraft): Record<string, string> {
  const common = {
    roleId: draft.roleId, name: draft.name, personaOrStance: draft.personaOrStance, model: draft.model
  }
  const sampling = Object.keys(draft.sampling).length === 0 ? undefined : draft.sampling
  const candidate = draft.provider === 'openai'
    ? { ...common, provider: 'openai', effort: draft.effort }
    : draft.provider === 'kimi'
      ? { ...common, provider: 'kimi', baseUrl: draft.baseUrl, thinking: draft.thinking,
          thinkingKeep: draft.thinkingKeep, ...(draft.effort === 'none' ? {} : { effort: draft.effort }),
          maxCompletionTokens: draft.maxOutputTokens, ...(sampling === undefined ? {} : { sampling }) }
      : { ...common, provider: 'deepseek', baseUrl: draft.baseUrl, thinking: draft.thinking,
          ...(draft.effort === 'none' ? {} : { effort: draft.effort }), maxTokens: draft.maxOutputTokens,
          ...(sampling === undefined ? {} : { sampling }) }
  const result = roleConfigSchema.safeParse(candidate)
  const errors: Record<string, string> = {}
  if (!result.success) {
    for (const issue of result.error.issues) {
      let path = issue.path.join('.')
      if (path === 'maxCompletionTokens' || path === 'maxTokens') path = 'maxOutputTokens'
      if (path !== '' && errors[path] === undefined) {
        errors[path] = path === 'name' ? '角色名称不能为空'
          : path === 'model' ? '请先获取并选择模型'
            : path === 'baseUrl' ? '请输入有效的 HTTPS Base URL' : issue.message
      }
    }
  }
  const capability = selectedModel(draft)
  if (capability?.maxOutputTokens !== undefined && draft.maxOutputTokens > capability.maxOutputTokens) {
    errors.maxOutputTokens = `不能超过模型上限 ${capability.maxOutputTokens}`
  }
  for (const parameter of capability?.samplingParameters ?? []) {
    const value = draft.sampling[parameter.name]
    if (value !== undefined && (value < parameter.min || value > parameter.max)) {
      errors[`sampling.${parameter.name}`] = `必须在 ${parameter.min} 到 ${parameter.max} 之间`
    }
  }
  return errors
}

function discoveryFieldErrors(draft: RoleDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.name.trim() === '') errors.name = '角色名称不能为空'
  if (draft.name.length > 100) errors.name = '角色名称不能超过 100 个字符'
  if (draft.personaOrStance.length > 4000) errors.personaOrStance = '角色立场不能超过 4000 个字符'
  if (draft.provider !== 'openai' && !baseUrlSchema.safeParse(draft.baseUrl).success) {
    errors.baseUrl = '请输入有效的 HTTPS Base URL'
  }
  return errors
}

interface AppStateValue {
  roles: Record<RoleId, RoleDraft>
  auth: { status: 'signed-out' | 'signing-in' | 'signed-in'; accountLabel?: string }
  loadStatus: 'loading' | 'ready' | 'error'
  loadError?: string
  retryLoad(): void
  updateRole(roleId: RoleId, change: Partial<RoleDraft>): void
  switchProvider(roleId: RoleId, provider: Provider): void
  selectModel(roleId: RoleId, modelId: string): void
  discover(roleId: RoleId, secret?: string, onSecretStored?: () => void): Promise<void>
  test(roleId: RoleId, secret: string, onSecretStored?: () => void): Promise<void>
  deleteSecret(roleId: RoleId): Promise<void>
  startLogin(): Promise<void>
  logout(): Promise<void>
  canContinue: boolean
}

const AppStateContext = createContext<AppStateValue | undefined>(undefined)

function normalizeModel(draft: RoleDraft, model: ModelCapability | undefined): RoleDraft {
  const allowedEfforts = draft.provider === 'openai'
    ? (model?.reasoningEfforts ?? [])
    : (model?.reasoningEfforts ?? []).filter((effort) => effort === 'low' || effort === 'high' || effort === 'max')
  const effort = model?.defaultReasoningEffort !== undefined && allowedEfforts.includes(model.defaultReasoningEffort)
    ? model.defaultReasoningEffort
    : (allowedEfforts[0] ?? 'none')
  const thinking = model?.thinking?.default
  const sampling = thinking === false
    ? Object.fromEntries((model?.samplingParameters ?? []).flatMap((parameter) =>
        parameter.default === undefined ? [] : [[parameter.name, parameter.default]]
      ))
    : {}
  return {
    ...draft,
    model: model?.id ?? '',
    effort,
    thinking,
    thinkingKeep: model?.thinking?.keepSupported && thinking ? 'all' : undefined,
    maxOutputTokens: model?.maxOutputTokens ?? draft.maxOutputTokens,
    sampling,
    connection: 'idle',
    error: model === undefined ? '没有发现可用模型' : undefined
  }
}

function applyDiscoveryCapabilities(draft: RoleDraft, capabilities: ProviderCapabilities): RoleDraft {
  const preserved = capabilities.models.find(({ id }) => id === draft.model)
  const modelId = preserved?.id ?? capabilities.defaultModel ?? capabilities.models[0]?.id ?? ''
  return {
    ...normalizeModel(draft, capabilities.models.find(({ id }) => id === modelId)),
    capabilities
  }
}

function applyTestCapabilities(
  draft: RoleDraft,
  capabilities: ProviderCapabilities
): { draft: RoleDraft; modelPresent: boolean } {
  if (capabilities.models.some(({ id }) => id === draft.model)) {
    return { draft: { ...draft, capabilities }, modelPresent: true }
  }
  return {
    draft: {
      ...draft,
      capabilities,
      model: '',
      effort: 'none',
      thinking: undefined,
      thinkingKeep: undefined,
      sampling: {},
      maxOutputTokens: providerDefaults[draft.provider].maxOutputTokens,
      connection: 'idle',
      fieldErrors: { model: '已测试的模型不再可用，请重新选择模型' },
      error: '模型目录已更新，请重新选择并测试'
    },
    modelPresent: false
  }
}

export function AppStateProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [roles, setRoles] = useState<Record<RoleId, RoleDraft>>({
    'role-a': emptyDraft('role-a'), 'role-b': emptyDraft('role-b')
  })
  const [auth, setAuth] = useState<AppStateValue['auth']>({ status: 'signed-out' })
  const [loadStatus, setLoadStatus] = useState<AppStateValue['loadStatus']>('loading')
  const [loadError, setLoadError] = useState<string>()
  const mounted = useRef(false)
  const loadGeneration = useRef(0)
  const authEventGeneration = useRef(0)

  const applyAuth = useCallback((status: AppStateValue['auth']) => {
    setAuth(status)
    if (status.status !== 'signed-in') {
      setRoles((current) => ({
        'role-a': current['role-a'].provider === 'openai'
          ? { ...current['role-a'], connection: 'idle' } : current['role-a'],
        'role-b': current['role-b'].provider === 'openai'
          ? { ...current['role-b'], connection: 'idle' } : current['role-b']
      }))
    }
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    const authGeneration = authEventGeneration.current
    setLoadStatus('loading')
    setLoadError(undefined)
    try {
      const [result, status] = await Promise.all([
        window.aiDebates.config.listRoles(), window.aiDebates.openAI.getAuthStatus()
      ])
      const loaded = await Promise.all(result.roles.map(async (role) => {
        const draft = fromRole(role)
        if (role.provider === 'openai') return draft
        const scope: CredentialScope = {
          roleId: role.roleId, provider: role.provider, origin: new URL(role.baseUrl).origin
        }
        const { found } = await window.aiDebates.credentials.hasProviderSecret({ scope })
        return { ...draft, credentialScope: scope, credentialPresent: found }
      }))
      if (!mounted.current || generation !== loadGeneration.current) return
      setRoles((current) => {
        const next = { ...current }
        for (const role of loaded) next[role.roleId] = role
        return next
      })
      if (authGeneration === authEventGeneration.current) applyAuth(status)
      setLoadStatus('ready')
    } catch {
      if (!mounted.current || generation !== loadGeneration.current) return
      setLoadError('无法读取已保存的配置，请稍后重试')
      setLoadStatus('error')
    }
  }, [applyAuth])

  useEffect(() => {
    mounted.current = true
    void load()
    const unsubscribe = window.aiDebates.openAI.onAuthChanged((status) => {
      if (mounted.current) {
        authEventGeneration.current += 1
        applyAuth(status)
      }
    })
    return () => {
      mounted.current = false
      loadGeneration.current += 1
      unsubscribe()
    }
  }, [applyAuth, load])

  const updateRole = useCallback((roleId: RoleId, change: Partial<RoleDraft>) => {
    setRoles((current) => {
      const previous = current[roleId]
      const scopeChanged = change.baseUrl !== undefined && change.baseUrl !== previous.baseUrl
      if (scopeChanged && previous.credentialPresent && previous.credentialScope !== undefined) {
        const oldScope = previous.credentialScope
        void window.aiDebates.credentials.deleteProviderSecret({ scope: oldScope }).catch(() => {
          setRoles((latest) => ({ ...latest, [roleId]: {
            ...latest[roleId], orphanedCredentialScope: oldScope, error: '旧凭据删除失败，请重试删除旧凭据'
          } }))
        })
      }
      return {
        ...current,
        [roleId]: {
          ...previous, ...change, connection: 'idle', error: undefined,
          fieldErrors: Object.fromEntries(Object.entries(previous.fieldErrors).filter(([path]) => {
            if (change.sampling !== undefined && path.startsWith('sampling.')) return false
            return !Object.keys(change).includes(path)
          })),
          ...(scopeChanged ? { credentialPresent: false, credentialScope: undefined } : {})
        }
      }
    })
  }, [])

  const switchProvider = useCallback((roleId: RoleId, provider: Provider) => {
    setRoles((current) => {
      const previous = current[roleId]
      if (previous.credentialPresent && previous.credentialScope !== undefined) {
        const oldScope = previous.credentialScope
        void window.aiDebates.credentials.deleteProviderSecret({ scope: oldScope }).catch(() => {
          setRoles((latest) => ({ ...latest, [roleId]: {
            ...latest[roleId], orphanedCredentialScope: oldScope, error: '旧凭据删除失败，请重试删除旧凭据'
          } }))
        })
      }
      return {
        ...current,
        [roleId]: {
          ...emptyDraft(roleId), name: previous.name, personaOrStance: previous.personaOrStance,
          provider, ...providerDefaults[provider], orphanedCredentialScope: previous.orphanedCredentialScope
        }
      }
    })
  }, [])

  const selectModel = useCallback((roleId: RoleId, modelId: string) => {
    setRoles((current) => {
      const draft = current[roleId]
      const model = draft.capabilities?.models.find(({ id }) => id === modelId)
      return { ...current, [roleId]: { ...normalizeModel(draft, model), connection: 'idle', fieldErrors: {} } }
    })
  }, [])

  const discover = useCallback(async (roleId: RoleId, secret = '', onSecretStored?: () => void) => {
    const draft = roles[roleId]
    const request = draft.provider === 'openai'
      ? { roleId, provider: 'openai' as const }
      : { roleId, provider: draft.provider, baseUrl: draft.baseUrl }
    const fieldErrors = discoveryFieldErrors(draft)
    if (Object.keys(fieldErrors).length > 0) {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], fieldErrors } }))
      return
    }
    setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: true, error: undefined } }))
    let credentialStored = false
    const hadCredential = draft.credentialPresent
    let storedScope: CredentialScope | undefined
    try {
      if (draft.provider !== 'openai' && secret.trim() !== '') {
        const scope: CredentialScope = { roleId, provider: draft.provider, origin: new URL(draft.baseUrl).origin }
        storedScope = scope
        await window.aiDebates.credentials.setProviderSecret({
          scope,
          secret
        })
        credentialStored = true
        onSecretStored?.()
        setRoles((current) => ({ ...current, [roleId]: {
          ...current[roleId], credentialScope: scope, credentialPresent: true
        } }))
      }
      const found = await window.aiDebates.providers.discoverCapabilities(request)
      setRoles((current) => ({
        ...current,
        [roleId]: current[roleId].provider === found.provider
          ? { ...applyDiscoveryCapabilities(current[roleId], found), busy: false }
          : current[roleId]
      }))
    } catch {
      let rollbackFailed = false
      if (credentialStored && !hadCredential && storedScope !== undefined) {
        try {
          await window.aiDebates.credentials.deleteProviderSecret({ scope: storedScope })
        } catch {
          rollbackFailed = true
        }
      }
      setRoles((current) => ({
        ...current,
        [roleId]: {
          ...current[roleId], busy: false,
          credentialPresent: rollbackFailed || hadCredential,
          credentialScope: rollbackFailed || hadCredential ? (storedScope ?? current[roleId].credentialScope) : undefined,
          error: rollbackFailed
            ? '获取模型失败，且新凭据清理失败；请手动删除凭据'
            : hadCredential && credentialStored ? '凭据已更新，但获取模型失败' : '获取模型失败'
        }
      }))
    }
  }, [roles])

  const deleteSecret = useCallback(async (roleId: RoleId): Promise<void> => {
    const draft = roles[roleId]
    const scope = draft.orphanedCredentialScope ?? draft.credentialScope
    if (scope === undefined) return
    try {
      await window.aiDebates.credentials.deleteProviderSecret({
        scope
      })
      setRoles((current) => ({ ...current, [roleId]: {
        ...current[roleId],
        ...(current[roleId].orphanedCredentialScope !== undefined
          ? { orphanedCredentialScope: undefined, error: undefined }
          : { credentialPresent: false, credentialScope: undefined, connection: 'idle', error: undefined })
      } }))
    } catch {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], error: '删除凭据失败' } }))
    }
  }, [roles])

  const test = useCallback(async (roleId: RoleId, secret: string, onSecretStored?: () => void): Promise<void> => {
    const draft = roles[roleId]
    const fieldErrors = zodFieldErrors(draft)
    const role = toRoleConfig(draft)
    if (role === undefined || Object.keys(fieldErrors).length > 0) {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], fieldErrors } }))
      return
    }
    setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: true, connection: 'testing', error: undefined } }))
    try {
      await window.aiDebates.config.saveRole({ role })
      if (role.provider !== 'openai' && secret.trim() !== '') {
        const scope: CredentialScope = { roleId, provider: role.provider, origin: new URL(role.baseUrl).origin }
        await window.aiDebates.credentials.setProviderSecret({
          scope,
          secret
        })
        onSecretStored?.()
        setRoles((current) => ({ ...current, [roleId]: {
          ...current[roleId], credentialScope: scope, credentialPresent: true
        } }))
      }
      const request = role.provider === 'openai'
        ? { roleId, provider: 'openai' as const }
        : { roleId, provider: role.provider, origin: new URL(role.baseUrl).origin }
      const result = await window.aiDebates.providers.testConnection(request)
      setRoles((current) => {
        const refreshed = result.capabilities === undefined
          ? { draft: current[roleId], modelPresent: true }
          : applyTestCapabilities(current[roleId], result.capabilities)
        return {
          ...current,
          [roleId]: {
            ...refreshed.draft,
            busy: false,
            connection: refreshed.modelPresent ? (result.ok ? 'passed' : 'failed') : 'idle',
            credentialPresent: current[roleId].credentialPresent || secret.trim() !== '',
            error: refreshed.modelPresent
              ? (result.ok ? undefined : (result.message ?? '连接测试失败'))
              : refreshed.draft.error
          }
        }
      })
    } catch {
      setRoles((current) => ({ ...current, [roleId]: { ...current[roleId], busy: false, connection: 'failed', error: '连接测试失败' } }))
    }
  }, [roles])

  const startLogin = useCallback(async () => {
    applyAuth({ status: 'signing-in' })
    try { await window.aiDebates.openAI.startLogin() } catch { applyAuth({ status: 'signed-out' }) }
  }, [applyAuth])
  const logout = useCallback(async () => {
    applyAuth({ status: 'signed-out' })
    try { await window.aiDebates.openAI.logout() } catch { /* status event remains authoritative */ }
  }, [applyAuth])

  const canContinue = (['role-a', 'role-b'] as const).every((id) =>
    roles[id].connection === 'passed' && toRoleConfig(roles[id]) !== undefined &&
      (roles[id].provider !== 'openai' || auth.status === 'signed-in')
  )
  const value = useMemo(() => ({
    roles, auth, loadStatus, loadError, retryLoad: () => { void load() }, updateRole, switchProvider,
    selectModel, discover, test, deleteSecret, startLogin, logout, canContinue
  }), [roles, auth, loadStatus, loadError, load, updateRole, switchProvider, selectModel, discover, test, deleteSecret, startLogin, logout, canContinue])
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
