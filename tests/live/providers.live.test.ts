import { copyFile, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { parseReply } from '../../src/main/debate/reply-parser'
import { CodexProvider } from '../../src/main/providers/codex/codex-provider'
import { startCodexAppServer } from '../../src/main/providers/codex/codex-process'
import { DeepSeekProvider } from '../../src/main/providers/deepseek/deepseek-provider'
import { KimiProvider } from '../../src/main/providers/kimi/kimi-provider'
import type { Provider, ProviderChunk, ProviderReplyRequest } from '../../src/main/providers/provider'
import type {
  DeepSeekRoleConfig,
  KimiRoleConfig,
  OpenAIRoleConfig,
  RoleConfig
} from '../../src/shared/domain'

const liveTimeoutMs = 60_000
const codexTimeoutMs = 120_000
const temporaryPaths = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })))
  temporaryPaths.clear()
})

const replyRequest = (role: RoleConfig): ProviderReplyRequest => ({
  sessionId: 'live-provider-check',
  turn: 1,
  role,
  view: {
    system: '只输出严格 JSON：{"speech":"一句简短中文回应","status":"continue"}。不要使用工具。',
    messages: [{ role: 'user', content: '请用一句话说明理性讨论的价值。' }],
    waiting: false
  }
})

const assertShortStructuredReply = async (
  provider: Provider,
  role: RoleConfig,
  timeoutMs = liveTimeoutMs
): Promise<void> => {
  const chunks: ProviderChunk[] = []
  for await (const chunk of provider.streamReply(replyRequest(role), AbortSignal.timeout(timeoutMs))) {
    chunks.push(chunk)
  }
  const content = chunks
    .filter((chunk): chunk is Extract<ProviderChunk, { type: 'content' }> => chunk.type === 'content')
    .map((chunk) => chunk.content)
    .join('')
  expect(chunks.some((chunk) => chunk.type === 'final')).toBe(true)
  const parsed = parseReply(content)
  expect(parsed.speech.trim().length).toBeGreaterThan(0)
  expect(parsed.status).toBe('continue')
}

describe.skipIf(process.env.KIMI_API_KEY === undefined)('Kimi live provider', () => {
  it('discovers models and returns one short structured response', async () => {
    const apiKey = process.env.KIMI_API_KEY
    if (apiKey === undefined || apiKey.trim() === '') throw new Error('KIMI_API_KEY must not be empty')
    const provider = new KimiProvider({ getApiKey: async () => apiKey })
    const discoveryRole: KimiRoleConfig = {
      roleId: 'role-a',
      name: 'Kimi live',
      personaOrStance: '简洁',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      maxCompletionTokens: 128
    }
    const capabilities = await provider.discover(discoveryRole, AbortSignal.timeout(liveTimeoutMs))
    const model = capabilities.defaultModel ?? capabilities.models[0]?.id
    if (model === undefined) throw new Error('Kimi model discovery returned no models')
    const role = { ...discoveryRole, model }
    await provider.discover(role, AbortSignal.timeout(liveTimeoutMs))
    await assertShortStructuredReply(provider, role)
  }, liveTimeoutMs * 3)
})

describe.skipIf(process.env.DEEPSEEK_API_KEY === undefined)('DeepSeek live provider', () => {
  it('discovers models and returns one short structured response', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new Error('DEEPSEEK_API_KEY must not be empty')
    }
    const provider = new DeepSeekProvider({ getApiKey: async () => apiKey })
    const discoveryRole: DeepSeekRoleConfig = {
      roleId: 'role-a',
      name: 'DeepSeek live',
      personaOrStance: '简洁',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      maxTokens: 128
    }
    const capabilities = await provider.discover(
      discoveryRole,
      AbortSignal.timeout(liveTimeoutMs)
    )
    const model = capabilities.defaultModel ?? capabilities.models[0]?.id
    if (model === undefined) throw new Error('DeepSeek model discovery returned no models')
    const role = { ...discoveryRole, model }
    await provider.discover(role, AbortSignal.timeout(liveTimeoutMs))
    await assertShortStructuredReply(provider, role)
  }, liveTimeoutMs * 3)
})

const accountProbeSchema = z.object({
  account: z.object({ type: z.string() }).passthrough().nullable().optional(),
  requiresOpenaiAuth: z.boolean()
}).passthrough()

const modelProbeSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    isDefault: z.boolean(),
    inputModalities: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().min(1),
    supportedReasoningEfforts: z.array(z.object({
      reasoningEffort: z.string().min(1)
    }).passthrough())
  }).passthrough()).min(1)
}).passthrough()

describe.skipIf(process.env.RUN_CODEX_LIVE_TEST !== '1')('Codex live provider', () => {
  it('uses explicit Codex 0.147 auth prerequisites, discovers models, and replies once', async () => {
    const codexBin = process.env.CODEX_BIN
    const authSource = process.env.CODEX_AUTH_SOURCE
    if (codexBin === undefined || !isAbsolute(codexBin) || codexBin.includes('\0')) {
      throw new Error('RUN_CODEX_LIVE_TEST=1 requires an absolute CODEX_BIN for Codex 0.147.0')
    }
    if (authSource === undefined || !isAbsolute(authSource) || authSource.includes('\0')) {
      throw new Error('RUN_CODEX_LIVE_TEST=1 requires an absolute CODEX_AUTH_SOURCE auth.json')
    }

    const root = await mkdtemp(join(tmpdir(), 'ai-debates-codex-live-'))
    temporaryPaths.add(root)
    const codexHome = join(root, 'codex-home')
    await mkdir(codexHome, { mode: 0o700 })
    await copyFile(authSource, join(codexHome, 'auth.json'))

    const client = await startCodexAppServer({
      clientVersion: '0.1.0-live-test',
      codexHome,
      isPackaged: false,
      resourcesPath: root,
      env: { CODEX_BIN: codexBin },
      hostEnv: process.env,
      rpc: { requestTimeoutMs: codexTimeoutMs }
    })
    const provider = new CodexProvider({
      createClient: async () => client,
      openExternal: async () => { throw new Error('Live test must use existing ChatGPT auth') },
      turnTimeoutMs: codexTimeoutMs
    })
    try {
      const account = await client.request(
        'account/read',
        { refreshToken: false },
        accountProbeSchema
      )
      if (account.account?.type !== 'chatgpt') {
        throw new Error('CODEX_AUTH_SOURCE is not an active ChatGPT login')
      }
      const catalog = await client.request(
        'model/list',
        { limit: 100, includeHidden: false },
        modelProbeSchema
      )
      const selected = catalog.data.find(
        (model) => model.isDefault && (model.inputModalities ?? ['text']).includes('text')
      ) ?? catalog.data.find((model) => (model.inputModalities ?? ['text']).includes('text'))
      if (selected === undefined) throw new Error('Codex model discovery returned no text model')
      const supportedEfforts = selected.supportedReasoningEfforts.map(
        ({ reasoningEffort }) => reasoningEffort
      )
      if (!supportedEfforts.includes(selected.defaultReasoningEffort)) {
        throw new Error('Codex default reasoning effort is not supported')
      }
      const role: OpenAIRoleConfig = {
        roleId: 'role-a',
        name: 'Codex live',
        personaOrStance: '简洁',
        provider: 'openai',
        model: selected.id,
        effort: selected.defaultReasoningEffort as OpenAIRoleConfig['effort']
      }
      await provider.discover(role, AbortSignal.timeout(codexTimeoutMs))
      await assertShortStructuredReply(provider, role, codexTimeoutMs)
    } finally {
      await provider.dispose()
    }
  }, codexTimeoutMs * 4)
})
