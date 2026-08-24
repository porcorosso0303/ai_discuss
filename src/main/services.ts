import { join } from 'node:path'

import type {
  CredentialScope,
  DebateEvent,
  DebateSession,
  DebateSetup,
  ProviderCapabilities,
  RoleConfig,
  RoleId
} from '../shared/domain'
import {
  IPC_CHANNELS,
  ipcInvokeContracts,
  type IpcEventChannel,
  type IpcEventMap,
  type IpcInvokeChannel
} from '../shared/ipc'
import { DebateOrchestrator } from './debate/orchestrator'
import { MarkdownExporter, type MarkdownExportResult } from './export/markdown-exporter'
import { CodexProvider, type CodexAccountStatus } from './providers/codex/codex-provider'
import { startCodexAppServer } from './providers/codex/codex-process'
import { DeepSeekProvider } from './providers/deepseek/deepseek-provider'
import { KimiProvider } from './providers/kimi/kimi-provider'
import { ProviderNonRetryableError, type Provider } from './providers/provider'
import { CredentialVault } from './security/credential-vault'
import { ConfigRepository } from './storage/config-repository'
import { DebateRepository, type DebateListOptions, type DebateSessionSummary } from './storage/debate-repository'
import { LogService } from './storage/log-service'

interface ConfigPort {
  listRoles(): Promise<RoleConfig[]>
  saveRole(role: unknown): Promise<RoleConfig>
  deleteRole(roleId: unknown): Promise<boolean>
}

interface CredentialPort {
  get(scope: CredentialScope, signal?: AbortSignal): Promise<string | undefined>
  set(scope: CredentialScope, secret: string, signal?: AbortSignal): Promise<{ stored: true }>
  delete(scope: CredentialScope, signal?: AbortSignal): Promise<{ deleted: true }>
  deleteRoleSecrets(roleId: RoleId, signal?: AbortSignal): Promise<unknown>
}

interface OpenAIProviderPort extends Provider {
  readAccount(): Promise<CodexAccountStatus>
  startChatGptLogin(): Promise<{ loginId: string; completion: Promise<void> }>
  logout(): Promise<void>
  dispose(): Promise<void>
}

interface DebateRepositoryPort {
  saveSession(session: DebateSession): Promise<void>
  list(options?: DebateListOptions): Promise<DebateSessionSummary[]>
  get(id: unknown): Promise<DebateSession | null>
  delete(id: unknown): Promise<boolean>
  clear(): Promise<number>
}

interface ExporterPort {
  export(session: unknown): Promise<MarkdownExportResult>
}

interface OrchestratorPort {
  start(setup: DebateSetup, signal?: AbortSignal): Promise<DebateSession>
  getSession(): DebateSession
  pause(): Promise<DebateSession>
  resume(): Promise<DebateSession>
  stop(): Promise<DebateSession>
  retryCurrentTurn(): Promise<DebateSession>
}

export interface DesktopServicesDependencies {
  version: string
  config: ConfigPort
  credentials: CredentialPort
  providers: { openai: OpenAIProviderPort; kimi: Provider; deepseek: Provider }
  repository: DebateRepositoryPort
  exporter: ExporterPort
  createOrchestrator(onEvent: (event: DebateEvent) => void): OrchestratorPort
  emit<Channel extends IpcEventChannel>(
    channel: Channel,
    payload: IpcEventMap[Channel]
  ): void | Promise<void>
  log?: { error(error: unknown, context?: unknown): Promise<void> | void }
  shutdownController?: AbortController
}

const terminalStates = new Set<DebateSession['state']>([
  'completed', 'stopped', 'unresolved', 'refused', 'failed'
])

const safeOperationError = (): Error => {
  const error = new Error('操作失败')
  Object.defineProperty(error, 'code', { value: 'DESKTOP_OPERATION_FAILED', enumerable: true })
  return error
}

const authStatus = (account: CodexAccountStatus): IpcEventMap[typeof IPC_CHANNELS.openAIAuthChanged] =>
  account.signedIn
    ? { status: 'signed-in', ...(account.planType === undefined ? {} : { accountLabel: account.planType }) }
    : { status: 'signed-out' }

export function isAllowedOpenAILoginUrl(raw: string): boolean {
  if (raw !== raw.normalize('NFKC')) return false
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    if (hostname.endsWith('.')) return false
    const allowed = hostname === 'openai.com' || hostname.endsWith('.openai.com') ||
      hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')
    return url.protocol === 'https:' && url.port === '' && url.username === '' &&
      url.password === '' && allowed
  } catch {
    return false
  }
}

export class DesktopServices {
  private readonly shutdown: AbortController
  private active?: OrchestratorPort
  private startInFlight?: Promise<DebateSession>
  private loginPending = false
  private disposed = false
  private disposePromise?: Promise<void>

  constructor(private readonly dependencies: DesktopServicesDependencies) {
    this.shutdown = dependencies.shutdownController ?? new AbortController()
  }

  async invoke(channel: IpcInvokeChannel, request: unknown): Promise<unknown> {
    try {
      this.ensureUsable()
      const input = ipcInvokeContracts[channel].request.parse(request)
      let response: unknown
      switch (channel) {
        case IPC_CHANNELS.appGetVersion:
          response = this.dependencies.version
          break
        case IPC_CHANNELS.configListRoles:
          response = { roles: await this.dependencies.config.listRoles() }
          break
        case IPC_CHANNELS.configSaveRole: {
          const { role } = ipcInvokeContracts[channel].request.parse(input)
          response = { role: await this.dependencies.config.saveRole(role) }
          break
        }
        case IPC_CHANNELS.configDeleteRole: {
          const { roleId } = ipcInvokeContracts[channel].request.parse(input)
          await this.dependencies.credentials.deleteRoleSecrets(roleId, this.shutdown.signal)
          response = { deleted: await this.dependencies.config.deleteRole(roleId) }
          break
        }
        case IPC_CHANNELS.credentialsSetProviderSecret: {
          const { scope, secret } = ipcInvokeContracts[channel].request.parse(input)
          await this.requireMatchingCredentialScope(scope)
          response = await this.dependencies.credentials.set(scope, secret, this.shutdown.signal)
          break
        }
        case IPC_CHANNELS.credentialsDeleteProviderSecret: {
          const { scope } = ipcInvokeContracts[channel].request.parse(input)
          await this.requireMatchingCredentialScope(scope)
          response = await this.dependencies.credentials.delete(scope, this.shutdown.signal)
          break
        }
        case IPC_CHANNELS.openAIGetAuthStatus:
          response = this.loginPending
            ? { status: 'signing-in' }
            : authStatus(await this.dependencies.providers.openai.readAccount())
          break
        case IPC_CHANNELS.openAIStartLogin:
          response = await this.startLogin()
          break
        case IPC_CHANNELS.openAILogout:
          await this.dependencies.providers.openai.logout()
          this.loginPending = false
          this.safeEmit(IPC_CHANNELS.openAIAuthChanged, { status: 'signed-out' })
          response = { signedOut: true }
          break
        case IPC_CHANNELS.providerDiscoverCapabilities: {
          const { roleId } = ipcInvokeContracts[channel].request.parse(input)
          response = await this.discoverSavedRole(roleId)
          break
        }
        case IPC_CHANNELS.providerTestConnection: {
          const test = ipcInvokeContracts[channel].request.parse(input)
          response = await this.testConnection(test)
          break
        }
        case IPC_CHANNELS.debateStart: {
          const { setup } = ipcInvokeContracts[channel].request.parse(input)
          response = { session: await this.startDebate(setup) }
          break
        }
        case IPC_CHANNELS.debatePause:
          response = await this.control(input, (orchestrator) => orchestrator.pause())
          break
        case IPC_CHANNELS.debateResume:
          response = await this.control(input, (orchestrator) => orchestrator.resume())
          break
        case IPC_CHANNELS.debateStop:
          response = await this.control(input, (orchestrator) => orchestrator.stop())
          break
        case IPC_CHANNELS.debateRetryCurrentTurn:
          response = await this.control(input, (orchestrator) => orchestrator.retryCurrentTurn())
          break
        case IPC_CHANNELS.historyList: {
          const options = ipcInvokeContracts[channel].request.parse(input)
          response = { sessions: await this.dependencies.repository.list(options) }
          break
        }
        case IPC_CHANNELS.historyGet: {
          const { sessionId } = ipcInvokeContracts[channel].request.parse(input)
          response = { session: await this.dependencies.repository.get(sessionId) }
          break
        }
        case IPC_CHANNELS.historyDelete: {
          const { sessionId } = ipcInvokeContracts[channel].request.parse(input)
          response = { deleted: await this.dependencies.repository.delete(sessionId) }
          break
        }
        case IPC_CHANNELS.historyClear:
          response = { deletedCount: await this.dependencies.repository.clear() }
          break
        case IPC_CHANNELS.exportMarkdown: {
          const { sessionId } = ipcInvokeContracts[channel].request.parse(input)
          const session = await this.dependencies.repository.get(sessionId)
          if (session === null) throw new Error('Missing session')
          response = await this.dependencies.exporter.export(session)
          break
        }
      }
      this.ensureUsable()
      return ipcInvokeContracts[channel].response.parse(response)
    } catch (error) {
      try {
        await this.dependencies.log?.error(error, { boundary: 'services', channel })
      } catch {
        // A logging failure must not change the safe renderer-facing error.
      }
      throw safeOperationError()
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.loginPending = false
    this.shutdown.abort(new DOMException('Application is closing', 'AbortError'))
    this.disposePromise = (async () => {
      const operations: Promise<unknown>[] = []
      if (this.active !== undefined) operations.push(Promise.resolve().then(() => this.active?.stop()))
      for (const provider of Object.values(this.dependencies.providers)) {
        if (provider.cancelActive !== undefined) operations.push(Promise.resolve().then(() => provider.cancelActive?.()))
      }
      operations.push(
        Promise.resolve().then(() => this.dependencies.providers.openai.dispose())
      )
      void this.startInFlight?.catch(() => undefined)
      await Promise.allSettled(operations)
    })()
    return this.disposePromise
  }

  private ensureUsable(): void {
    if (this.disposed || this.shutdown.signal.aborted) throw new Error('Services are closed')
  }

  private async role(roleId: RoleId): Promise<RoleConfig> {
    const role = (await this.dependencies.config.listRoles()).find((candidate) => candidate.roleId === roleId)
    if (role === undefined) throw new Error('Role is not configured')
    return role
  }

  private async discoverSavedRole(roleId: RoleId): Promise<ProviderCapabilities> {
    const role = await this.role(roleId)
    return await this.dependencies.providers[role.provider].discover(role, this.shutdown.signal)
  }

  private async requireMatchingCredentialScope(scope: CredentialScope): Promise<void> {
    const role = await this.role(scope.roleId)
    if (
      role.provider === 'openai' ||
      role.provider !== scope.provider ||
      new URL(role.baseUrl).origin !== scope.origin
    ) {
      throw new Error('Credential scope does not match the saved role')
    }
  }

  private async testConnection(
    input: { roleId: RoleId; provider: 'openai' } |
      { roleId: RoleId; provider: 'kimi' | 'deepseek'; origin: string }
  ): Promise<unknown> {
    const role = await this.role(input.roleId)
    if (role.provider !== input.provider) throw new Error('Provider mismatch')
    if (role.provider !== 'openai') {
      if (!('origin' in input) || new URL(role.baseUrl).origin !== input.origin) {
        throw new Error('Origin mismatch')
      }
    }
    try {
      const capabilities = await this.dependencies.providers[role.provider].discover(role, this.shutdown.signal)
      return { ok: true, capabilities }
    } catch {
      return { ok: false, message: '连接测试失败，请检查模型配置和凭据' }
    }
  }

  private async startLogin(): Promise<{ started: true }> {
    const attempt = await this.dependencies.providers.openai.startChatGptLogin()
    this.loginPending = true
    this.safeEmit(IPC_CHANNELS.openAIAuthChanged, { status: 'signing-in' })
    void Promise.resolve(attempt.completion)
      .then(
        () => this.finishLogin(),
        () => this.failLogin()
      )
      .catch((error: unknown) => this.recordAsyncFailure(error, 'login-completion'))
    return { started: true }
  }

  private async finishLogin(): Promise<void> {
    this.loginPending = false
    if (this.disposed) return
    try {
      const account = await this.dependencies.providers.openai.readAccount()
      if (!this.disposed) this.safeEmit(IPC_CHANNELS.openAIAuthChanged, authStatus(account))
    } catch (error) {
      if (!this.disposed) this.safeEmit(IPC_CHANNELS.openAIAuthChanged, { status: 'signed-out' })
      await this.recordAsyncFailure(error, 'login-account-read')
    }
  }

  private failLogin(): void {
    this.loginPending = false
    if (!this.disposed) this.safeEmit(IPC_CHANNELS.openAIAuthChanged, { status: 'signed-out' })
  }

  private safeEmit<Channel extends IpcEventChannel>(
    channel: Channel,
    payload: IpcEventMap[Channel]
  ): void {
    if (this.disposed) return
    let result: void | Promise<void>
    try {
      result = this.dependencies.emit(channel, payload)
    } catch (error) {
      void this.recordAsyncFailure(error, 'event-sink')
      return
    }
    void Promise.resolve(result)
      .catch((error: unknown) => this.recordAsyncFailure(error, 'event-sink'))
      .catch(() => undefined)
  }

  private async recordAsyncFailure(error: unknown, operation: string): Promise<void> {
    try {
      await this.dependencies.log?.error(error, { boundary: 'services', operation })
    } catch {
      // Background error reporting is terminal and best effort.
    }
  }

  private async startDebate(setup: DebateSetup): Promise<DebateSession> {
    if (this.startInFlight !== undefined) throw new Error('Debate start is already in progress')
    if (this.active !== undefined) {
      const current = this.active.getSession()
      if (!terminalStates.has(current.state)) throw new Error('A debate is already active')
    }
    const orchestrator = this.dependencies.createOrchestrator((event) => {
      this.safeEmit(IPC_CHANNELS.debateEvent, event)
    })
    this.active = orchestrator
    const pending = orchestrator.start(setup, this.shutdown.signal)
    this.startInFlight = pending
    try {
      const session = await pending
      if (this.disposed || this.shutdown.signal.aborted) {
        if (this.active === orchestrator) this.active = undefined
        throw new Error('Services are closed')
      }
      return session
    } catch (error) {
      if (this.active === orchestrator) this.active = undefined
      throw error
    } finally {
      if (this.startInFlight === pending) this.startInFlight = undefined
    }
  }

  private async control(
    input: unknown,
    operation: (orchestrator: OrchestratorPort) => Promise<DebateSession>
  ): Promise<{ accepted: true }> {
    const { sessionId } = ipcInvokeContracts[IPC_CHANNELS.debatePause].request.parse(input)
    const orchestrator = this.active
    if (orchestrator === undefined || orchestrator.getSession().id !== sessionId) {
      throw new Error('Session mismatch')
    }
    await operation(orchestrator)
    return { accepted: true }
  }
}

export interface ProductionDesktopServicesOptions {
  emit<Channel extends IpcEventChannel>(
    channel: Channel,
    payload: IpcEventMap[Channel]
  ): void | Promise<void>
  app: {
    getPath(name: 'userData'): string
    getVersion(): string
    readonly isPackaged: boolean
  }
  resourcesPath: string
  env?: Readonly<NodeJS.ProcessEnv>
  dialog: ConstructorParameters<typeof MarkdownExporter>[0]
  openExternal(url: string): Promise<unknown>
}

export function createProductionDesktopServices({
  emit,
  app,
  resourcesPath,
  env = process.env,
  dialog,
  openExternal
}: ProductionDesktopServicesOptions): {
  services: DesktopServices
  log: LogService
} {
  const root = app.getPath('userData')
  const config = new ConfigRepository(root)
  const repository = new DebateRepository(root)
  const log = new LogService(root)
  const shutdownController = new AbortController()
  const credentials = new CredentialVault({
    isPackaged: app.isPackaged,
    resourcesPath,
    env,
    hostEnv: env
  })
  const secretFor = async (
    role: Exclude<RoleConfig, { provider: 'openai' }>,
    signal: AbortSignal
  ): Promise<string> => {
    const secret = await credentials.get({
      roleId: role.roleId,
      provider: role.provider,
      origin: new URL(role.baseUrl).origin
    }, signal)
    if (secret === undefined) throw new ProviderNonRetryableError('Provider credential is missing')
    return secret
  }
  const openai = new CodexProvider({
    createClient: () => startCodexAppServer({
      clientVersion: app.getVersion(),
      codexHome: join(root, 'codex'),
      isPackaged: app.isPackaged,
      resourcesPath,
      env
    }),
    openExternal: async (url) => {
      if (!isAllowedOpenAILoginUrl(url)) throw new Error('Unsafe OpenAI login URL')
      await openExternal(url)
    }
  })
  const providers = {
    openai,
    kimi: new KimiProvider({
      getApiKey: (role) => secretFor(role, shutdownController.signal)
    }),
    deepseek: new DeepSeekProvider({
      getApiKey: (role, signal) => secretFor(
        role,
        signal === undefined
          ? shutdownController.signal
          : AbortSignal.any([shutdownController.signal, signal])
      )
    })
  }
  const exporter = new MarkdownExporter(dialog)
  const services = new DesktopServices({
    version: app.getVersion(), config, credentials, providers, repository, exporter, emit, log,
    shutdownController,
    createOrchestrator: (onEvent) => new DebateOrchestrator({ registry: providers, repository, onEvent })
  })
  return { services, log }
}
