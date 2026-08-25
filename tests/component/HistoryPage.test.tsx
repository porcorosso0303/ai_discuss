// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AiDebatesApi } from '../../src/preload'
import { HistoryPage } from '../../src/renderer/src/pages/HistoryPage'
import type { DebateSession } from '../../src/shared/domain'
import { createSession } from '../helpers/debate-fixtures'

const older = createSession({
  id: 'older', state: 'completed', terminationReason: 'agreed',
  createdAt: '2026-08-20T01:00:00.000Z', updatedAt: '2026-08-20T02:00:00.000Z'
})
const newer = createSession({
  id: 'newer', state: 'paused',
  setup: { ...createSession().setup, topic: '可恢复的新辩论' },
  createdAt: '2026-08-21T01:00:00.000Z', updatedAt: '2026-08-21T02:00:00.000Z',
  messages: [{
    id: 'message-1', turn: 1, roleId: 'role-a', provider: 'openai', model: 'gpt-5',
    speech: '历史观点正文', status: 'continue', createdAt: '2026-08-21T01:01:00.000Z',
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
  }], currentTurn: 1
})

const summary = (session: DebateSession) => ({
  id: session.id, topic: session.setup.topic, state: session.state,
  currentTurn: session.currentTurn, createdAt: session.createdAt, updatedAt: session.updatedAt
})

function installApi() {
  const api = {
    history: {
      list: vi.fn(async () => ({ sessions: [summary(older), summary(newer)] })),
      get: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        session: sessionId === newer.id ? newer : older
      })),
      delete: vi.fn(async () => ({ deleted: true })),
      clear: vi.fn(async () => ({ deletedCount: 2 }))
    },
    debate: { recover: vi.fn(async () => ({ session: newer })) },
    export: { markdown: vi.fn(async () => ({ cancelled: false, fileName: '辩论记录.md' })) }
  }
  Object.defineProperty(window, 'aiDebates', {
    configurable: true,
    value: api as unknown as AiDebatesApi
  })
  return api
}

afterEach(cleanup)

describe('history page', () => {
  it('lists newest first, searches, and loads a read-only detail', async () => {
    const api = installApi()
    const user = userEvent.setup()
    render(<HistoryPage onRecover={vi.fn()} />)

    const items = await screen.findAllByRole('button', { name: /查看/ })
    expect(items[0]).toHaveAccessibleName(/可恢复的新辩论/)
    expect(api.history.list).toHaveBeenCalledWith({ limit: 50 })

    await user.clear(screen.getByRole('searchbox', { name: '搜索历史记录' }))
    await user.type(screen.getByRole('searchbox', { name: '搜索历史记录' }), '教育 公平')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    expect(api.history.list).toHaveBeenLastCalledWith({ limit: 50, search: '教育 公平' })

    await user.click(screen.getByRole('button', { name: /查看可恢复的新辩论/ }))
    expect(await screen.findByRole('heading', { name: '可恢复的新辩论' })).toBeInTheDocument()
    expect(screen.getByText('历史观点正文')).toBeInTheDocument()
    expect(screen.getByText(/gpt-5/)).toBeInTheDocument()
    expect(screen.getByText('总用量：14 tokens')).toBeInTheDocument()
  })

  it('exports, confirms deletion safely, and keeps data when deletion fails', async () => {
    const api = installApi()
    const user = userEvent.setup()
    render(<HistoryPage onRecover={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /查看可恢复的新辩论/ }))

    await user.click(await screen.findByRole('button', { name: '导出 Markdown' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已保存：辩论记录.md')

    await user.click(screen.getByRole('button', { name: '删除此记录' }))
    const dialog = screen.getByRole('dialog', { name: '删除历史记录' })
    expect(within(dialog).getByRole('button', { name: '取消' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(api.history.delete).not.toHaveBeenCalled()

    api.history.delete.mockResolvedValueOnce({ deleted: false })
    await user.click(screen.getByRole('button', { name: '删除此记录' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败')
    expect(screen.getByRole('heading', { name: '可恢复的新辩论' })).toBeInTheDocument()

    api.history.delete.mockRejectedValueOnce(new Error('disk error'))
    await user.click(screen.getByRole('button', { name: '删除此记录' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败')
    expect(screen.getByRole('heading', { name: '可恢复的新辩论' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '删除此记录' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: '可恢复的新辩论' })).not.toBeInTheDocument())
  })

  it('requires confirmation to clear and exposes passive recovery only for incomplete sessions', async () => {
    const api = installApi()
    const onRecover = vi.fn()
    const user = userEvent.setup()
    render(<HistoryPage onRecover={onRecover} />)

    await user.click(await screen.findByRole('button', { name: /查看人工智能会改善教育吗/ }))
    expect(await screen.findByRole('heading', { name: older.setup.topic })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载并恢复' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /查看可恢复的新辩论/ }))
    expect(await screen.findByText('加载后不会自动继续')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '加载并恢复' }))
    await waitFor(() => expect(onRecover).toHaveBeenCalledWith(newer))
    expect(api.debate.recover).toHaveBeenCalledWith({ sessionId: 'newer' })

    await user.click(screen.getByRole('button', { name: '清空历史记录' }))
    await user.click(within(screen.getByRole('dialog', { name: '清空历史记录' }))
      .getByRole('button', { name: '确认清空' }))
    expect(api.history.clear).toHaveBeenCalledOnce()
    expect(await screen.findByText('暂无历史记录')).toBeInTheDocument()
  })

  it('shows an empty state and can retry a failed initial load', async () => {
    const api = installApi()
    api.history.list.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ sessions: [] })
    const user = userEvent.setup()
    render(<HistoryPage onRecover={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载历史记录')
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无历史记录')).toBeInTheDocument()
  })
})
