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
    provider: 'deepseek', defaultModel: 'deepseek-dynamic', models: [
      {
        id: 'deepseek-dynamic', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high',
        thinking: { default: true, keepSupported: false }, maxOutputTokens: 4096,
        samplingParameters: [
          { name: 'temperature', min: 0, max: 2, default: 1 },
          { name: 'topP', min: 0, max: 1, default: 0.9 }
        ],
        structuredOutputModes: ['json-object']
      },
      {
        id: 'deepseek-fast', reasoningEfforts: [], thinking: { default: false, keepSupported: false },
        maxOutputTokens: 2048,
        samplingParameters: [
          { name: 'temperature', min: 0, max: 1, default: 0.4 },
          { name: 'topP', min: 0, max: 1, default: 0.8 }
        ],
        structuredOutputModes: ['json-object']
      }
    ]
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
      deleteProviderSecret: vi.fn(async () => ({ deleted: true })),
      hasProviderSecret: vi.fn(async () => ({ found: false }))
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

  it('normalizes every dependent field when the selected model changes', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    expect(within(card).getByLabelText('思考强度')).toHaveValue('high')

    await user.selectOptions(within(card).getByLabelText('模型'), 'deepseek-fast')
    expect(within(card).getByLabelText('思考模式')).not.toBeChecked()
    expect(within(card).queryByLabelText('思考强度')).not.toBeInTheDocument()
    expect(within(card).getByLabelText('最大输出 Token')).toHaveValue(2048)
    await user.click(within(card).getByText('高级参数'))
    expect(within(card).getByLabelText('temperature')).toHaveValue(0.4)
    expect(within(card).getByLabelText('topP')).toHaveValue(0.8)
  })

  it('preserves the selected model when connection testing refreshes the same catalog', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.selectOptions(within(card).getByLabelText('模型'), 'deepseek-fast')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText('连接正常')).toBeInTheDocument()
    expect(within(card).getByLabelText('模型')).toHaveValue('deepseek-fast')
  })

  it('preserves every tested DeepSeek parameter when refreshed capabilities still contain the model', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.selectOptions(within(card).getByLabelText('模型'), 'deepseek-fast')
    await user.click(within(card).getByText('高级参数'))
    const maxTokens = within(card).getByLabelText('最大输出 Token')
    const temperature = within(card).getByLabelText('temperature')
    const topP = within(card).getByLabelText('topP')
    await user.clear(maxTokens); await user.type(maxTokens, '1024')
    await user.clear(temperature); await user.type(temperature, '0.7')
    await user.clear(topP); await user.type(topP, '0.6')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText('连接正常')).toBeInTheDocument()
    expect(within(card).getByLabelText('模型')).toHaveValue('deepseek-fast')
    expect(within(card).getByLabelText('思考模式')).not.toBeChecked()
    expect(maxTokens).toHaveValue(1024)
    expect(temperature).toHaveValue(0.7)
    expect(topP).toHaveValue(0.6)
  })

  it('preserves legal Kimi keep/max and K3 effort values across a test refresh', async () => {
    const { api } = apiHarness()
    const kimiCatalog: ProviderCapabilities = {
      provider: 'kimi', defaultModel: 'moonshot-dynamic', models: [
        capabilities.kimi.models[0]!,
        {
          id: 'kimi-k3-test', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
          thinking: null, maxOutputTokens: 12000, samplingParameters: [],
          structuredOutputModes: ['json-object']
        }
      ]
    }
    ;(api.providers.discoverCapabilities as ReturnType<typeof vi.fn>).mockResolvedValue(kimiCatalog)
    ;(api.providers.testConnection as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, capabilities: kimiCatalog })
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'kimi')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.click(within(card).getByLabelText('思考模式'))
    const genericMax = within(card).getByLabelText('最大输出 Token')
    await user.clear(genericMax); await user.type(genericMax, '6000')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    const savedGeneric = (api.config.saveRole as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].role
    expect(savedGeneric).toMatchObject({ model: 'moonshot-dynamic', thinking: true, thinkingKeep: 'all', maxCompletionTokens: 6000 })

    await user.selectOptions(within(card).getByLabelText('模型'), 'kimi-k3-test')
    await user.selectOptions(within(card).getByLabelText('思考强度'), 'low')
    const k3Max = within(card).getByLabelText('最大输出 Token')
    await user.clear(k3Max); await user.type(k3Max, '7000')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(within(card).getByLabelText('模型')).toHaveValue('kimi-k3-test')
    expect(within(card).getByLabelText('思考强度')).toHaveValue('low')
    expect(k3Max).toHaveValue(7000)
  })

  it('cannot pass when refreshed capabilities no longer contain the tested model', async () => {
    const { api } = apiHarness()
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.selectOptions(within(card).getByLabelText('模型'), 'deepseek-fast')
    ;(api.providers.testConnection as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      capabilities: { ...capabilities.deepseek, defaultModel: 'deepseek-dynamic', models: [capabilities.deepseek.models[0]] }
    })
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    await waitFor(() => expect(within(card).getByLabelText('模型')).toHaveValue(''))
    expect(within(card).queryByText('连接正常')).not.toBeInTheDocument()
    expect(within(card).getByText('未测试')).toBeInTheDocument()
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
    const { api, emitAuth } = apiHarness()
    ;(api.openAI.getAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'signed-in' })
    const user = userEvent.setup()
    render(<App />)
    emitAuth({ status: 'signed-in' })
    const continueButton = await screen.findByRole('button', { name: '进入辩论设置' })
    expect(continueButton).toBeDisabled()

    for (const label of ['角色 A 配置', '角色 B 配置']) {
      const card = screen.getByRole('region', { name: label })
      await user.click(within(card).getByRole('button', { name: '获取模型' }))
      await user.click(within(card).getByRole('button', { name: '测试连接' }))
    }
    await waitFor(() => expect(continueButton).toBeEnabled())

    await user.type(within(screen.getByRole('region', { name: '角色 A 配置' })).getByLabelText('角色立场'), '新观点')
    expect(continueButton).toBeDisabled()
  })

  it('invalidates passed OpenAI roles when auth starts or becomes signed out', async () => {
    const { api, emitAuth } = apiHarness()
    ;(api.openAI.getAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'signed-in' })
    const user = userEvent.setup()
    render(<App />)
    emitAuth({ status: 'signed-in' })
    const continueButton = await screen.findByRole('button', { name: '进入辩论设置' })
    for (const label of ['角色 A 配置', '角色 B 配置']) {
      const card = screen.getByRole('region', { name: label })
      await user.click(within(card).getByRole('button', { name: '获取模型' }))
      await user.click(within(card).getByRole('button', { name: '测试连接' }))
    }
    expect(continueButton).toBeEnabled()
    emitAuth({ status: 'signing-in' })
    await waitFor(() => expect(continueButton).toBeDisabled())
    expect(screen.getAllByText('未测试')).toHaveLength(2)
  })

  it('resets OpenAI connection state immediately on logout', async () => {
    const { api, emitAuth } = apiHarness()
    ;(api.openAI.getAuthStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 'signed-in' })
    const user = userEvent.setup()
    render(<App />)
    emitAuth({ status: 'signed-in' })
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(within(card).getByText('连接正常')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: '退出登录' }))
    expect(within(card).getByText('未测试')).toBeInTheDocument()
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
    const baseUrl = within(card).getByLabelText('Base URL')
    expect(await within(card).findByText('请输入有效的 HTTPS Base URL')).toBeInTheDocument()
    expect(baseUrl).toHaveAttribute('aria-invalid', 'true')
    expect(baseUrl).toHaveAccessibleDescription('请输入有效的 HTTPS Base URL')
    expect(api.providers.discoverCapabilities).not.toHaveBeenCalled()
  })

  it('places validation errors beside fields and clears them when edited', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    const name = within(card).getByLabelText('角色名称')
    await user.clear(name)
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    expect(await within(card).findByText('角色名称不能为空')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAccessibleDescription('角色名称不能为空')
    await user.type(name, '修正名称')
    expect(within(card).queryByText('角色名称不能为空')).not.toBeInTheDocument()
  })

  it('validates output and sampling numbers against the selected capability', async () => {
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await user.selectOptions(within(card).getByLabelText('模型'), 'deepseek-fast')
    await user.click(within(card).getByText('高级参数'))
    const maxTokens = within(card).getByLabelText('最大输出 Token')
    const temperature = within(card).getByLabelText('temperature')
    await user.clear(maxTokens); await user.type(maxTokens, '9999')
    await user.clear(temperature); await user.type(temperature, '1.5')
    await user.click(within(card).getByRole('button', { name: '测试连接' }))
    expect(await within(card).findByText('不能超过模型上限 2048')).toBeInTheDocument()
    expect(within(card).getByText('必须在 0 到 1 之间')).toBeInTheDocument()
    expect(maxTokens).toHaveAttribute('max', '2048')
    expect(temperature).toHaveAttribute('aria-invalid', 'true')
  })

  it('checks the canonical saved-role scope instead of assuming a credential exists', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ roles: [{
      roleId: 'role-a', provider: 'kimi', name: '已保存角色', personaOrStance: '',
      model: 'moonshot-dynamic', baseUrl: 'https://api.moonshot.cn/v1/', maxCompletionTokens: 4096
    }] })
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    expect(await within(card).findByDisplayValue('已保存角色')).toBeInTheDocument()
    expect(within(card).getByLabelText('API Key')).toHaveValue('')
    expect(within(card).getByLabelText('API Key')).toHaveAttribute('placeholder', '输入 API Key')
    expect(api.credentials.hasProviderSecret).toHaveBeenCalledWith({
      scope: { roleId: 'role-a', provider: 'kimi', origin: 'https://api.moonshot.cn' }
    })
  })

  it('shows a saved credential only when the vault confirms its current scope', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ roles: [{
      roleId: 'role-a', provider: 'kimi', name: '已保存角色', personaOrStance: '',
      model: 'moonshot-dynamic', baseUrl: 'https://api.moonshot.cn/v1/', maxCompletionTokens: 4096
    }] })
    ;(api.credentials.hasProviderSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ found: true })
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    expect(await within(card).findByRole('button', { name: '删除已保存凭据' })).toBeInTheDocument()
    expect(within(card).getByLabelText('API Key')).toHaveAttribute('placeholder', expect.stringContaining('已保存凭据'))
  })

  it('best-effort deletes the old known credential scope when provider changes', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ roles: [{
      roleId: 'role-a', provider: 'kimi', name: '已保存角色', personaOrStance: '',
      model: 'moonshot-dynamic', baseUrl: 'https://api.moonshot.cn/v1/', maxCompletionTokens: 4096
    }] })
    ;(api.credentials.hasProviderSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ found: true })
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await within(card).findByRole('button', { name: '删除已保存凭据' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await waitFor(() => expect(api.credentials.deleteProviderSecret).toHaveBeenCalledWith({
      scope: { roleId: 'role-a', provider: 'kimi', origin: 'https://api.moonshot.cn' }
    }))
    expect(within(card).getByLabelText('API Key')).toHaveAttribute('placeholder', '输入 API Key')
  })

  it('keeps a failed old-scope cleanup actionable without blocking provider editing', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ roles: [{
      roleId: 'role-a', provider: 'kimi', name: '已保存角色', personaOrStance: '',
      model: 'moonshot-dynamic', baseUrl: 'https://api.moonshot.cn/v1/', maxCompletionTokens: 4096
    }] })
    ;(api.credentials.hasProviderSecret as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ found: true })
    ;(api.credentials.deleteProviderSecret as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('vault busy'))
      .mockResolvedValueOnce({ deleted: true })
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await within(card).findByRole('button', { name: '删除已保存凭据' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    expect(await within(card).findByRole('button', { name: '重试删除旧凭据' })).toBeInTheDocument()
    expect(within(card).getByLabelText('服务商')).toHaveValue('deepseek')
    await user.click(within(card).getByRole('button', { name: '重试删除旧凭据' }))
    await waitFor(() => expect(within(card).queryByRole('button', { name: '重试删除旧凭据' })).not.toBeInTheDocument())
    expect(api.credentials.deleteProviderSecret).toHaveBeenCalledTimes(2)
  })

  it('rolls back a newly stored credential when first discovery fails', async () => {
    const { api } = apiHarness()
    ;(api.providers.discoverCapabilities as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'))
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    await user.selectOptions(within(card).getByLabelText('服务商'), 'deepseek')
    await user.type(within(card).getByLabelText('API Key'), 'rollback-me')
    await user.click(within(card).getByRole('button', { name: '获取模型' }))
    await waitFor(() => expect(api.credentials.deleteProviderSecret).toHaveBeenCalledWith({
      scope: { roleId: 'role-a', provider: 'deepseek', origin: 'https://api.deepseek.com' }
    }))
    expect(within(card).getByLabelText('API Key')).toHaveValue('')
    expect(within(card).queryByRole('button', { name: '删除已保存凭据' })).not.toBeInTheDocument()
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

  it('disables editing while deferred initialization protects the eventual loaded values', async () => {
    const { api } = apiHarness()
    let finishLoad!: (value: { roles: unknown[] }) => void
    ;(api.config.listRoles as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise((resolve) => { finishLoad = resolve })
    )
    const user = userEvent.setup()
    render(<App />)
    const card = await screen.findByRole('region', { name: '角色 A 配置' })
    const name = within(card).getByLabelText('角色名称')
    expect(name).toBeDisabled()
    await user.type(name, '不应写入')
    expect(name).toHaveValue('辩手 A')
    finishLoad({ roles: [{
      roleId: 'role-a', provider: 'openai', name: '服务端配置', personaOrStance: '',
      model: 'gpt-dynamic', effort: 'high'
    }] })
    expect(await within(card).findByDisplayValue('服务端配置')).toBeEnabled()
  })

  it('shows a retry state after initialization failure and recovers on retry', async () => {
    const { api } = apiHarness()
    ;(api.config.listRoles as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValueOnce({ roles: [] })
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取已保存的配置')
    const roleA = screen.getByRole('region', { name: '角色 A 配置' })
    expect(within(roleA).getByLabelText('角色名称')).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '重试加载' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试加载' })).not.toBeInTheDocument())
    expect(within(roleA).getByLabelText('角色名称')).toBeEnabled()
  })

  it('ignores stale StrictMode initialization and settles cleanup after unmount', async () => {
    const { api, unsubscribe } = apiHarness()
    let finishFirst!: (value: { roles: unknown[] }) => void
    let finishSecond!: (value: { roles: unknown[] }) => void
    ;(api.config.listRoles as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
      .mockReturnValueOnce(new Promise((resolve) => { finishSecond = resolve }))
    const view = render(<StrictMode><App /></StrictMode>)
    finishSecond({ roles: [{
      roleId: 'role-a', provider: 'openai', name: '最新配置', personaOrStance: '',
      model: 'gpt-dynamic', effort: 'high'
    }] })
    expect(await screen.findByDisplayValue('最新配置')).toBeInTheDocument()
    finishFirst({ roles: [{
      roleId: 'role-a', provider: 'openai', name: '过期配置', personaOrStance: '',
      model: 'gpt-dynamic', effort: 'high'
    }] })
    await Promise.resolve()
    expect(screen.queryByDisplayValue('过期配置')).not.toBeInTheDocument()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })
})
