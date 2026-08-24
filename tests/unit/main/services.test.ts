import { describe, expect, it, vi } from 'vitest'

import {
  DesktopServices,
  isAllowedOpenAILoginUrl,
  type DesktopServicesDependencies
} from '../../../src/main/services'
import type { CodexAccountStatus } from '../../../src/main/providers/codex/codex-provider'
import { IPC_CHANNELS } from '../../../src/shared/ipc'
import type { CredentialScope, RoleConfig } from '../../../src/shared/domain'
import { createSession, kimiRole, openAIRole } from '../../helpers/debate-fixtures'

function harness() {
  const roles = [openAIRole, kimiRole]
  const config = {
    listRoles: vi.fn(async () => roles),
    saveRole: vi.fn(async (role: RoleConfig) => role),
    deleteRole: vi.fn(async () => true)
  }
  const credentials = {
    get: vi.fn(async () => 'secret'),
    set: vi.fn(async () => ({ stored: true as const })),
    delete: vi.fn<(
      scope: CredentialScope,
      signal?: AbortSignal
    ) => Promise<{ deleted: true }>>(async () => ({ deleted: true })),
    deleteRoleSecrets: vi.fn(async () => ({ deletedProviders: ['kimi'] as const }))
  }
  const capabilities = {
    provider: 'kimi' as const,
    models: [{
      id: kimiRole.model,
      reasoningEfforts: [],
      thinking: null,
      samplingParameters: [],
      structuredOutputModes: ['json-object' as const]
    }],
    defaultModel: kimiRole.model
  }
  const providers = {
    openai: {
      discover: vi.fn(async () => ({ ...capabilities, provider: 'openai' as const })),
      streamReply: vi.fn(), cancelActive: vi.fn(), dispose: vi.fn(),
      readAccount: vi.fn<() => Promise<CodexAccountStatus>>(async () => ({ signedIn: false, requiresOpenaiAuth: true })),
      startChatGptLogin: vi.fn(), logout: vi.fn()
    },
    kimi: { discover: vi.fn(async () => capabilities), streamReply: vi.fn(), cancelActive: vi.fn() },
    deepseek: { discover: vi.fn(async () => ({ ...capabilities, provider: 'deepseek' as const })), streamReply: vi.fn(), cancelActive: vi.fn() }
  }
  const repository = {
    saveSession: vi.fn(), list: vi.fn(async () => []), get: vi.fn(async () => null),
    delete: vi.fn(async () => true), clear: vi.fn(async () => 2)
  }
  const exporter = { export: vi.fn(async () => ({ cancelled: false, fileName: 'debate.md' })) }
  const session = createSession({ state: 'running' })
  const orchestrator = {
    start: vi.fn(async () => session),
    getSession: vi.fn(() => session),
    pause: vi.fn(async () => ({ ...session, state: 'paused' as const })),
    resume: vi.fn(async () => session), stop: vi.fn(async () => ({ ...session, state: 'stopped' as const })),
    retryCurrentTurn: vi.fn(async () => session)
  }
  const emit = vi.fn()
  const log = { error: vi.fn().mockResolvedValue(undefined) }
  const dependencies = {
    version: '0.1.0', config, credentials, providers, repository, exporter,
    createOrchestrator: vi.fn(() => orchestrator), emit, log
  } as DesktopServicesDependencies
  return { config, credentials, dependencies, emit, exporter, log, orchestrator, providers, repository, roles }
}

describe('desktop services', () => {
  it('removes secrets before deleting a role and never reports partial deletion as success', async () => {
    const h = harness()
    const services = new DesktopServices(h.dependencies)
    await expect(services.invoke(IPC_CHANNELS.configDeleteRole, { roleId: 'role-a' })).resolves.toEqual({ deleted: true })
    expect(h.credentials.deleteRoleSecrets).toHaveBeenCalledWith('role-a', expect.any(AbortSignal))
    expect(h.config.deleteRole).toHaveBeenCalledWith('role-a')

    h.credentials.deleteRoleSecrets.mockRejectedValueOnce(new Error('contains secret / path'))
    await expect(services.invoke(IPC_CHANNELS.configDeleteRole, { roleId: 'role-b' })).rejects.toThrow('操作失败')
    expect(h.config.deleteRole).not.toHaveBeenCalledWith('role-b')
    expect(h.log.error).toHaveBeenCalledWith(expect.any(Error), {
      boundary: 'services', channel: IPC_CHANNELS.configDeleteRole
    })
  })

  it('discovers only saved roles and requires an exact provider/origin match for tests', async () => {
    const h = harness()
    const services = new DesktopServices(h.dependencies)
    await services.invoke(IPC_CHANNELS.providerDiscoverCapabilities, { roleId: 'role-b' })
    expect(h.providers.kimi.discover).toHaveBeenCalledWith(kimiRole, expect.any(AbortSignal))

    await expect(services.invoke(IPC_CHANNELS.providerTestConnection, {
      roleId: 'role-b', provider: 'kimi', origin: 'https://evil.test/'
    })).rejects.toThrow('操作失败')
    expect(h.providers.kimi.discover).toHaveBeenCalledTimes(1)

    await expect(services.invoke(IPC_CHANNELS.credentialsSetProviderSecret, {
      scope: { roleId: 'role-b', provider: 'kimi', origin: 'https://evil.test/' },
      secret: 'not-stored'
    })).rejects.toThrow('操作失败')
    expect(h.credentials.set).not.toHaveBeenCalled()
  })

  it('publishes auth changes without leaking login URLs or rejected login promises', async () => {
    const h = harness()
    let complete!: () => void
    const completion = new Promise<void>((resolve) => { complete = resolve })
    h.providers.openai.startChatGptLogin.mockResolvedValueOnce({ loginId: 'login-1', completion })
    h.providers.openai.readAccount.mockResolvedValueOnce({ signedIn: true, requiresOpenaiAuth: true, planType: 'plus' })
    const services = new DesktopServices(h.dependencies)
    await expect(services.invoke(IPC_CHANNELS.openAIStartLogin, {})).resolves.toEqual({ started: true })
    await expect(services.invoke(IPC_CHANNELS.openAIGetAuthStatus, {})).resolves.toEqual({ status: 'signing-in' })
    expect(h.emit).toHaveBeenCalledWith(
      IPC_CHANNELS.openAIAuthChanged,
      { status: 'signing-in' }
    )
    complete()
    await vi.waitFor(() => expect(h.emit).toHaveBeenCalledWith(
      IPC_CHANNELS.openAIAuthChanged,
      { status: 'signed-in', accountLabel: 'plus' }
    ))
  })

  it('enforces a single session, exact session controls, and shutdown cancellation', async () => {
    const h = harness()
    const services = new DesktopServices(h.dependencies)
    const setup = createSession().setup
    await services.invoke(IPC_CHANNELS.debateStart, { setup })
    await expect(services.invoke(IPC_CHANNELS.debatePause, { sessionId: 'other' })).rejects.toThrow('操作失败')
    await services.invoke(IPC_CHANNELS.debatePause, { sessionId: 'session-1' })
    await services.invoke(IPC_CHANNELS.credentialsDeleteProviderSecret, {
      scope: { roleId: 'role-b', provider: 'kimi', origin: 'https://api.moonshot.cn' }
    })
    await services.dispose()
    await services.dispose()
    expect(h.orchestrator.stop).toHaveBeenCalledOnce()
    expect(h.providers.openai.cancelActive).toHaveBeenCalledOnce()
    expect(h.providers.kimi.cancelActive).toHaveBeenCalledOnce()
    expect(h.providers.deepseek.cancelActive).toHaveBeenCalledOnce()
    expect(h.providers.openai.dispose).toHaveBeenCalledOnce()
    const deletionSignal = h.credentials.delete.mock.calls[0]?.[1]
    expect(deletionSignal?.aborted).toBe(true)
    await expect(services.invoke(IPC_CHANNELS.historyClear, {})).rejects.toThrow('操作失败')
  })

  it('closes Codex promptly when a debate start ignores its aborted validation signal', async () => {
    const h = harness()
    let validationSignal: AbortSignal | undefined
    h.orchestrator.start.mockImplementation((...args: unknown[]) => {
      validationSignal = args[1] as AbortSignal
      return new Promise(() => undefined)
    })
    const services = new DesktopServices(h.dependencies)
    const starting = services.invoke(IPC_CHANNELS.debateStart, { setup: createSession().setup })
    void starting.catch(() => undefined)
    await vi.waitFor(() => expect(h.orchestrator.start).toHaveBeenCalledOnce())

    await expect(Promise.race([
      services.dispose().then(() => 'disposed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 40))
    ])).resolves.toBe('disposed')
    expect(validationSignal?.aborted).toBe(true)
    expect(h.providers.openai.dispose).toHaveBeenCalledOnce()
  })

  it('contains synchronous event sink failures throughout login completion', async () => {
    const h = harness()
    let complete!: () => void
    const completion = new Promise<void>((resolve) => { complete = resolve })
    h.providers.openai.startChatGptLogin.mockResolvedValueOnce({ loginId: 'login-1', completion })
    h.providers.openai.readAccount.mockResolvedValue({ signedIn: true, requiresOpenaiAuth: true })
    h.emit.mockImplementation(() => { throw new Error('renderer was destroyed') })
    const services = new DesktopServices(h.dependencies)

    await expect(services.invoke(IPC_CHANNELS.openAIStartLogin, {})).resolves.toEqual({ started: true })
    complete()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(services.invoke(IPC_CHANNELS.openAIGetAuthStatus, {})).resolves.toEqual({ status: 'signed-in' })
  })
})

describe('OpenAI login URL allowlist', () => {
  it.each([
    'https://auth.openai.com/oauth/authorize?x=1',
    'https://chatgpt.com/auth/login',
    'https://sub.chatgpt.com/'
  ])('accepts %s', (url) => expect(isAllowedOpenAILoginUrl(url)).toBe(true))

  it.each([
    'http://auth.openai.com/', 'https://openai.com.evil.test/',
    'https://openai.com./', 'https://user@openai.com/',
    'https://ｏｐｅｎａｉ.com/'
  ])('rejects %s', (url) => expect(isAllowedOpenAILoginUrl(url)).toBe(false))
})
