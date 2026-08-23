import { readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MarkdownExporter,
  renderDebateMarkdown
} from '../../../src/main/export/markdown-exporter'
import { createSession } from '../../helpers/debate-fixtures'
import { createTempDirectory, removeTempDirectories } from '../../helpers/temp-directories'

const completedSession = () =>
  createSession({
    state: 'completed',
    currentTurn: 1,
    winnerRoleId: 'role-a',
    terminationReason: 'conceded',
    updatedAt: '2026-08-11T10:01:00.000Z',
    messages: [
      {
        id: 'message-1',
        turn: 1,
        roleId: 'role-a',
        provider: 'openai',
        model: 'gpt-5',
        speech:
          '我的论点：\n```md\n# 这不是导出标题\n```\nclient_secret=raw-speech-secret',
        status: 'continue',
        createdAt: '2026-08-11T10:00:30.000Z',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          reasoningTokens: 999
        }
      }
    ],
    events: [
      {
        id: 'warning-1',
        sessionId: 'session-1',
        createdAt: '2026-08-11T10:00:20.000Z',
        type: 'warning',
        code: 'provider-warning',
        message:
          'reasoning=private-chain Authorization: Bearer raw-auth token=raw-token rawPayload=body'
      }
    ]
  })

describe('renderDebateMarkdown', () => {
  it('contains topic, safe role summaries, formal speeches, public usage, and result only', () => {
    const markdown = renderDebateMarkdown(completedSession())

    expect(markdown).toContain('人工智能会改善教育吗？')
    expect(markdown).toContain('正方')
    expect(markdown).toContain('OpenAI')
    expect(markdown).toContain('gpt-5')
    expect(markdown).toContain('我的论点')
    expect(markdown).toContain('胜方：正方')
    expect(markdown).toContain('输入用量：10')
    expect(markdown).not.toContain('999')
    expect(markdown).not.toContain('private-chain')
    expect(markdown).not.toContain('raw-auth')
    expect(markdown).not.toContain('raw-token')
    expect(markdown).not.toContain('rawPayload')
    expect(markdown).not.toContain('raw-speech-secret')
    expect(
      markdown.split('\n').filter((line) => line.trimEnd() === '# 这不是导出标题')
    ).toHaveLength(1)
  })

  it('strictly validates input and does not execute nested getters', () => {
    const unsafe = completedSession() as unknown as Record<string, unknown>
    Object.defineProperty(unsafe, 'trap', {
      enumerable: true,
      get: () => {
        throw new Error('getter executed')
      }
    })

    expect(() => renderDebateMarkdown(unsafe)).toThrow(/accessor/i)
  })

  it('prevents role and model inline text from injecting Markdown structure', () => {
    const session = completedSession()
    const markdown = renderDebateMarkdown({
      ...session,
      setup: {
        ...session.setup,
        roles: [
          { ...session.setup.roles[0], name: '正方\n## 伪造结果', model: 'gpt-5\n# 伪造标题' },
          session.setup.roles[1]
        ]
      }
    })

    expect(markdown.split(/\r?\n/)).not.toContain('## 伪造结果')
    expect(markdown.split(/\r?\n/)).not.toContain('# 伪造标题')
  })
})

describe('MarkdownExporter', () => {
  afterEach(removeTempDirectories)

  it('does not write when the injected save dialog is cancelled', async () => {
    const root = await createTempDirectory('markdown-cancel-')
    const showSaveDialog = vi.fn(async (_options: { defaultPath: string }) => ({ canceled: true }))
    const exporter = new MarkdownExporter({ showSaveDialog })

    expect(await exporter.export(completedSession())).toEqual({ cancelled: true })
    expect(showSaveDialog).toHaveBeenCalledOnce()
    expect(await readFile(join(root, 'unused.md'), 'utf8').catch(() => null)).toBeNull()
  })

  it('sanitizes topic and session id before proposing a Windows file name', async () => {
    const showSaveDialog = vi.fn(async (_options: { defaultPath: string }) => ({ canceled: true }))
    const exporter = new MarkdownExporter({ showSaveDialog })

    const session = completedSession()
    await exporter.export({
      ...session,
      id: 'session/../unsafe',
      setup: { ...session.setup, topic: 'bad/name:*?' }
    })
    const options = showSaveDialog.mock.calls[0]?.[0]
    expect(options?.defaultPath).not.toMatch(/[<>:"/\\|?*]/)
  })

  it('atomically writes the user-selected local Markdown path and returns only its file name', async () => {
    const root = await createTempDirectory('markdown-export-')
    const filePath = join(root, '辩论记录.md')
    const exporter = new MarkdownExporter({
      showSaveDialog: async () => ({ canceled: false, filePath })
    })

    expect(await exporter.export(completedSession())).toEqual({
      cancelled: false,
      fileName: '辩论记录.md'
    })
    expect(await readFile(filePath, 'utf8')).toContain('人工智能会改善教育吗？')
  })

  it('rejects a symlink overwrite target', async () => {
    const root = await createTempDirectory('markdown-symlink-')
    const target = join(root, 'real.md')
    const link = join(root, 'selected.md')
    await symlink(target, link)
    const exporter = new MarkdownExporter({
      showSaveDialog: async () => ({ canceled: false, filePath: link })
    })

    await expect(exporter.export(completedSession())).rejects.toThrow(/symlink/i)
  })
})
