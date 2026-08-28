import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test'

import { MockProviderServer } from './mock-provider-server'

const electronExecutable = resolve(
  'node_modules/electron/dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

interface DesktopFixtures {
  electronApp: ElectronApplication
  page: Page
  mockServer: MockProviderServer
  testRoot: string
  exportPath: string
  testKey: string
}

export const test = base.extend<DesktopFixtures>({
  testRoot: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'ai-debates-e2e-'))
    await use(root)
    await rm(root, { recursive: true, force: true })
  },
  testKey: async ({}, use) => use(`e2e-key-${crypto.randomUUID()}`),
  exportPath: async ({ testRoot }, use) => use(resolve(testRoot, 'debate-export.md')),
  mockServer: async ({}, use) => {
    const server = new MockProviderServer()
    await server.start()
    await use(server)
    await server.close()
  },
  electronApp: async ({ testRoot, exportPath }, use) => {
    const app = await electron.launch({
      executablePath: electronExecutable,
      args: ['--no-sandbox', resolve('out/main/index.js')],
      env: {
        ...process.env,
        AI_DEBATES_E2E_CREDENTIAL_FILE: resolve(testRoot, 'credentials.json'),
        AI_DEBATES_E2E_EXPORT_PATH: exportPath,
        XDG_CONFIG_HOME: testRoot,
        APPDATA: testRoot,
        LOCALAPPDATA: testRoot,
        HOME: testRoot
      }
    })
    await use(app)
    await app.close()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.getByRole('heading', { name: '配置 AI 角色' }).waitFor()
    await use(page)
  }
})

export { expect }

export async function configureRoles(page: Page, server: MockProviderServer, key: string): Promise<void> {
  const cards = [
    { label: '角色 A 配置', provider: 'Kimi', baseUrl: `${server.baseUrl}/kimi/v1` },
    { label: '角色 B 配置', provider: 'DeepSeek', baseUrl: `${server.baseUrl}/deepseek` }
  ] as const
  for (const card of cards) {
    const region = page.getByRole('region', { name: card.label })
    await region.getByLabel('服务商').selectOption({ label: card.provider })
    await region.getByLabel('API Key').fill(key)
    await region.getByText('高级设置').first().click()
    await region.getByLabel('Base URL').fill(card.baseUrl)
    await region.getByRole('button', { name: '获取模型' }).click()
    await expect(region.getByLabel('API Key')).toHaveValue('')
    await expect(region.getByLabel('模型')).not.toHaveValue('')
    await region.getByRole('button', { name: '测试连接' }).click()
    await expect(region).toContainText('连接正常')
  }
  await expect(page.getByRole('button', { name: '进入辩论设置' })).toBeEnabled()
}

export async function startDebate(page: Page, topic: string, maxTurns?: number): Promise<void> {
  await page.getByRole('button', { name: '进入辩论设置' }).click()
  await page.getByRole('textbox', { name: '辩论话题' }).fill(topic)
  await page.getByLabel(/角色 B ·/).check()
  if (maxTurns !== undefined) await page.getByLabel('最大轮次').fill(String(maxTurns))
  await page.getByRole('button', { name: '开始辩论' }).click()
}
