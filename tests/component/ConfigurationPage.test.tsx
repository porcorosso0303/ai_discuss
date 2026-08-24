// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../../src/renderer/src/App'
import type { AiDebatesApi } from '../../src/preload'
import type { Provider, ProviderCapabilities } from '../../src/shared/domain'

const capabilities: Record<'openai' | 'kimi' | 'deepseek', ProviderCapabilities> = {
  openai: {
    provider: 'openai', defaultModel: 'gpt-dynamic', models: [{
      id: 'gpt-dynamic', displayName: 'GPT Dynamic', reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high', thinking: null, samplingParameters: [],
      structuredOutputModes: ['json-schema']
    }]
  },
  kimi: {
    provider: 'kimi', defaultModel: 'moonshot-dynamic', models: [{
      id: 'moonshot-dynamic', reasoningEfforts: [], thinking: { default: false, keepSupported: true },
      maxOutputTokens: 8192,
      samplingParameters: [{ name: 'temperature', min: 0, max: 1, default: 0.6 }],
      structuredOutputModes: ['json-object']
    }]
  },
  deepseek: {
    provider: 'deepseek', defaultModel: 'deepseek-dynamic', models: [{
      id: 'deepseek-dynamic', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
      thinking: { default: true, keepSupported: false }, maxOutputTokens: 4096,
      samplingParameters: [
        { name: 'temperature', min: 0, max: 2, default: 1 },
        { name: 'topP', min: 0, max: 1, default: 0.9 }
      ],
      structuredOutputModes: ['json-object']
    }]
  }
}

function apiHarness() {
  let authListener: ((status: { status: 'signed-out' | 'signing-in' | 'signed-in'; accountLabel?: string }) => void) | undefined
  const unsubscribe = vi.fn()
  const api = {
    config: {
      listRoles: vi.fn(async () => ({ roles: [] })),
      saveRole: vi.fn(async ({ role }) => ({ role })),
      deleteRole: vi.fn()
    },
    credentials: {
      setProviderSecret: vi.fn(async () => ({ stored: true })),
      deleteProviderSecret: vi.fn()
    },
    openAI: {
      getAuthStatus: vi.fn(async () => ({ status: 'signed-out' as const })),
      startLogin: vi.fn(async () => ({ started: true })),
      logout: vi.fn(async () => ({ signedOut: true })),
      onAuthChanged: vi.fn((listener) => { authListener = listener; return unsubscribe })
    },
    providers: {
      discoverCapabilities: vi.fn(async ({ provider }: { provider: Provider }) => capabilities[provider]),
      testConnection: vi.fn(async ({ provider }: { provider: Provider }) => ({ ok: true, capabilities: capabilities[provider] }))
    }
  } as unknown as AiDebatesApi
  Object.defineProperty(window, 'aiDebates', { configurable: true, value: api })
  return { api, unsubscribe, emitAuth: (status: Parameters<NonNullable<typeof authListener>>[0]) => authListener?.(status) }
}

afterEach(cleanup)

describe('role configuration page', () => {
  beforeEach(() => apiHarness())

  it('renders the desktop shell and both independently labelled role cards', async () => {
    render(<App />)
    expect(await screen.findByRole('heading', { name: '配置 AI 角色' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '角色 A 配置' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '角色 B 配置' })).toBeInTheDocument()
    expect(screen.getAllByText(/Windows Credential Manager/).length).toBeGreaterThan(0)
  })

  it('switches provider-specific fields and never offers an API key for OpenAI', async () => {
    const user = userEvent.setup()
    render(<App />)
    const roleA = await screen.findByRole('region', { name: '角色 A 配置' })
    expect(within(roleA).getByRole('button', { name: '使用 ChatGPT 登录' })).toBeInTheDocument()
    expect(within(roleA).queryByLabelText('API Key')).not.toBeInTheDocument()

    await user.selectOptions(within(roleA).getByLabelText('服务商'), 'kimi')
    expect(within(roleA).getByLabelText('API Key')).toHaveAttribute('type', 'password')
    expect(within(roleA).getByLabelText('Base URL')).toHaveValue('https://api.moonshot.cn/v1')
    expect(within(roleA).queryByRole('button', { name: '使用 ChatGPT 登录' })).not.toBeInTheDocument()
  })

  it('uses discovered model capabilities and hides sampling while DeepSeek thinking is enabled', async () => {
    const user = userEvent.setup()
    render(<App />)
    const roleA = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(roleA).getByLabelText('服务商'), 'deepseek')
    await user.click(within(roleA).getByRole('button', { name: '获取模型' }))

    expect(within(roleA).getByLabelText('模型')).toHaveValue('deepseek-dynamic')
    expect(within(roleA).getByLabelText('思考模式')).toBeChecked()
    await user.click(within(roleA).getByText('高级参数'))
    expect(within(roleA).queryByLabelText('temperature')).not.toBeInTheDocument()

    await user.click(within(roleA).getByLabelText('思考模式'))
    expect(within(roleA).getByLabelText('temperature')).toBeInTheDocument()
    expect(within(roleA).getByLabelText('topP')).toBeInTheDocument()
  })

  it('clears an entered API key after storing it and never sends it in saved role config', async () => {
    const { api } = apiHarness()
    const user = userEvent.setup()
    render(<App />)
    const roleA = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(roleA).getByLabelText('服务商'), 'kimi')
    await user.click(within(roleA).getByRole('button', { name: '获取模型' }))
    await user.type(within(roleA).getByLabelText('API Key'), 'sk-local-secret')
    await user.click(within(roleA).getByRole('button', { name: '测试连接' }))

    expect(await within(roleA).findByText('连接正常')).toBeInTheDocument()
    expect(within(roleA).getByLabelText('API Key')).toHaveValue('')
    expect(api.credentials.setProviderSecret).toHaveBeenCalledWith(expect.objectContaining({ secret: 'sk-local-secret' }))
    expect(JSON.stringify((api.config.saveRole as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('sk-local-secret')
    expect(document.body).not.toHaveTextContent('sk-local-secret')
  })

  it('clears the API key immediately after storage while the connection test is still pending', async () => {
    const { api } = apiHarness()
    let finishTest!: (value: { ok: true }) => void
    ;(api.providers.testConnection as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { finishTest = resolve })
    )
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'kimi')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.type(within(card).getByLabelText('API Key'), 'short-lived-secret')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))

    await waitFor(() => expect(api.credentials.setProviderSecret).toHaveBeenCalled())
    expect(within(card).getByLabelText('API Key')).toHaveValue('')
    finishTest({ ok: true })
    expect(await within(card).findByText('连接正常')).toBeInTheDocument()
  })

  it('stores a temporary key before first model discovery and offers explicit credential deletion', async () => {
    const { api } = apiHarness()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'kimi')
    await user.type(within(card).getByLabelText('API Key'), 'first-use-secret')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))

    expect(api.credentials.setProviderSecret).toHaveBeenCalledWith({
      scope: { roleId: 'role-a', provider: 'kimi', origin: 'https://api.moonshot.cn' },
      secret: 'first-use-secret'
    })
    expect((api.credentials.setProviderSecret as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((api.providers.discoverCapabilities as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? 0)
    expect(within(card).getByLabelText('API Key')).toHaveValue('')

    await user.click(within(card).getByRole('button', { name: '删除已保存凭据' }))
    expect(api.credentials.deleteProviderSecret).toHaveBeenCalledWith({
      scope: { roleId: 'role-a', provider: 'kimi', origin: 'https://api.moonshot.cn' }
    })
  })

  it('keeps continue disabled until two valid roles pass connection tests', async () => {
    const user = userEvent.setup()
    render(<App />)
    const continueButton = await screen.findByRole('button', { name: '进入辩论设置' })
    expect(continueButton).toBeDisabled()

    for (const label of ['角色 A 配置', '角色 B 配置']) {
      const card = screen.getByRole('region', { name: label })
      await user.click(within(card).getByRole('button', { name: '获取模型' }))
      await user.click(within(card).getByRole('button', { name: '测试连接' }))
    }
    expect(continueButton).toBeEnabled()

    await user.type(within(screen.getByRole('region', { name: '角色 A 配置' })).getByLabelText('角色立场'), '新观点')
    expect(continueButton).toBeDisabled()
  })

  it('invalidates a passed connection when a new secret is entered', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'kimi')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(within(card).getByText('连接正常')).toBeInTheDocument()
    await user.type(within(card).getByLabelText('API Key'), 'replacement')
    expect(within(card).getByText('未测试')).toBeInTheDocument()
  })

  it('shows invalid base URL next to the role without invoking discovery', async () => {
    const { api } = apiHarness()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByText('高级设置'))
    await user.clear(within(card).getByLabelText('Base URL'))
    await user.type(within(card).getByLabelText('Base URL'), 'http://remote.example')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    expect(await within(card).findByRole('alert')).toHaveTextContent('有效的 HTTPS Base URL')
    expect(api.providers.discoverCapabilities).not.toHaveBeenCalled()
  })

  it('loads saved roles without restoring secrets into the API key input', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ roles: [{
      roleId: 'role-a', provider: 'kimi', name: '已保存角色', personaOrStance: '',
      model: 'moonshot-dynamic', baseUrl: 'https://api.moonshot.cn/v1/', maxCompletionTokens: 4096
    }] })
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    expect(await within(card).findByDisplayValue('已保存角色')).toBeInTheDocument()
    expect(within(card).getByLabelText('API Key')).toHaveValue('')
    expect(within(card).getByLabelText('API Key')).toHaveAttribute('placeholder', expect.stringContaining('已保存凭据'))
  })

  it('updates auth events and cleans every StrictMode subscription', async () => {
    const { api, emitAuth, unsubscribe } = apiHarness()
    const view = render(<StrictMode><App /></StrictMode>)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    emitAuth({ status: 'signed-in', accountLabel: 'Plus' })
    expect(await within(card).findByText(/已登录 · Plus/)).toBeInTheDocument()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    expect(api.openAI.onAuthChanged).toHaveBeenCalledTimes(2)
  })
})
