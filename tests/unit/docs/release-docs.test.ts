import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const text = (path: string): Promise<string> => readFile(resolve(root, path), 'utf8')

describe('release documentation', () => {
  it('documents the complete portable user workflow and limitations in Chinese', async () => {
    const readme = await text('README.md')

    for (const required of [
      '便携版', 'ChatGPT', 'Kimi', 'DeepSeek', '自定义 Base URL',
      '100', '暂停', '继续', '停止', '导出', 'Credential Manager',
      'SmartScreen', '%LOCALAPPDATA%/AI Debates', '已知限制'
    ]) {
      expect(readme).toContain(required)
    }
    expect(readme).toContain('总正式发言')
    expect(readme).toContain('RUN_KIMI_LIVE_TEST=1')
    expect(readme).toContain('RUN_DEEPSEEK_LIVE_TEST=1')
    expect(readme).toContain('RUN_CODEX_LIVE_TEST=1')
  })

  it('records dated official API sources and their code contracts', async () => {
    const sources = await text('docs/official-api-sources.md')

    expect(sources).toContain('2026-08-29')
    for (const url of [
      'https://developers.openai.com/codex/cli',
      'https://developers.openai.com/codex/app-server/',
      'https://platform.kimi.com/docs/api/overview',
      'https://platform.kimi.com/docs/api/chat',
      'https://platform.kimi.com/docs/introduction',
      'https://api-docs.deepseek.com/api/create-chat-completion/',
      'https://api-docs.deepseek.com/guides/thinking_mode/'
    ]) {
      expect(sources).toContain(url)
    }
    expect(sources).not.toContain('https://platform.kimi.com/docs/guide/start')
    expect(sources).not.toContain('版本及文件哈希由 staging/verification 脚本校验')
    expect(sources).toContain('tests/unit/providers/codex/codex-events.test.ts')
    expect(sources).toContain('sha256sum -c SHA256SUMS')
    expect(sources).toMatch(/代码映射|固定合同/u)
  })

  it('provides a Windows smoke checklist with expected and actual result fields', async () => {
    const smoke = await text('docs/windows-smoke-test.md')

    for (const heading of ['Expected', 'Actual', 'Pass', 'Notes']) {
      expect(smoke).toContain(heading)
    }
    for (const required of [
      'Windows 10', 'Windows 11', 'x64', '无需管理员权限', '中文路径',
      '登录', '退出', '重新登录', '删除', '暂停', '停止', '恢复', '导出'
    ]) {
      expect(smoke).toContain(required)
    }
    expect(smoke).toContain('cd native/credential-helper')
    expect(smoke).toContain('GOCACHE=/tmp/ai-debates-go-cache go test ./...')
    expect(smoke).toContain('Set-Location native/credential-helper')
    expect(smoke).toContain('RUN_KIMI_LIVE_TEST=1')
    expect(smoke).toContain('RUN_DEEPSEEK_LIVE_TEST=1')
    expect(smoke).toContain('仅设置 API Key 不会启用 live test')
    expect(smoke).toContain('CI 不设置上述 RUN_*_LIVE_TEST 开关')
  })

  it('publishes a 0.1.0 changelog with unsigned-build limitations', async () => {
    const changelog = await text('CHANGELOG.md')

    expect(changelog).toContain('0.1.0')
    expect(changelog).toContain('未签名')
    expect(changelog).toContain('双角色')
  })
})
