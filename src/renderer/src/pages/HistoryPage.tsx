import { useCallback, useEffect, useRef, useState } from 'react'

import type { DebateSession } from '../../../shared/domain'
import type { DebateSessionSummary } from '../../../shared/ipc'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { HistoryDetail } from '../components/HistoryDetail'
import { HistoryList } from '../components/HistoryList'

type Confirmation = { kind: 'delete'; sessionId: string } | { kind: 'clear' }

export function HistoryPage({ onRecover }: {
  onRecover(session: DebateSession): void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<DebateSessionSummary[]>([])
  const [selected, setSelected] = useState<DebateSession>()
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [query, setQuery] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const listGeneration = useRef(0)
  const detailGeneration = useRef(0)
  const operationGeneration = useRef(0)

  const loadList = useCallback((search?: string): void => {
    const generation = ++listGeneration.current
    detailGeneration.current += 1
    operationGeneration.current += 1
    setLoading(true)
    setDetailLoading(false)
    setBusy(false)
    setSelected(undefined)
    setNotice(undefined)
    setError(undefined)
    const trimmed = search?.trim() ?? ''
    void window.aiDebates.history.list({ limit: 50, ...(trimmed === '' ? {} : { search: trimmed }) })
      .then(({ sessions: result }) => {
        if (generation !== listGeneration.current) return
        setSessions([...result].sort((a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.updatedAt.localeCompare(a.updatedAt)
        ))
      })
      .catch(() => {
        if (generation === listGeneration.current) setError('无法加载历史记录，请重试')
      })
      .finally(() => {
        if (generation === listGeneration.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    loadList()
    return () => {
      listGeneration.current += 1
      detailGeneration.current += 1
      operationGeneration.current += 1
    }
  }, [loadList])

  const selectSession = (sessionId: string): void => {
    const generation = ++detailGeneration.current
    operationGeneration.current += 1
    setDetailLoading(true)
    setBusy(false)
    setSelected(undefined)
    setError(undefined)
    setNotice(undefined)
    void window.aiDebates.history.get({ sessionId }).then(({ session }) => {
      if (generation !== detailGeneration.current) return
      if (session === null) throw new Error('missing')
      setSelected(session)
    }).catch(() => {
      if (generation === detailGeneration.current) setError('无法加载历史详情，请重试')
    }).finally(() => {
      if (generation === detailGeneration.current) setDetailLoading(false)
    })
  }

  const exportSelected = (): void => {
    if (selected === undefined || busy) return
    const generation = ++operationGeneration.current
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    void window.aiDebates.export.markdown({ sessionId: selected.id }).then((result) => {
      if (generation !== operationGeneration.current) return
      setNotice(result.cancelled ? '已取消保存' : `已保存：${result.fileName ?? 'Markdown 文件'}`)
    }).catch(() => {
      if (generation === operationGeneration.current) setError('导出失败，请重试')
    }).finally(() => {
      if (generation === operationGeneration.current) setBusy(false)
    })
  }

  const recoverSelected = (): void => {
    if (selected === undefined || busy) return
    const generation = ++operationGeneration.current
    setBusy(true)
    setError(undefined)
    void window.aiDebates.debate.recover({ sessionId: selected.id })
      .then(({ session }) => {
        if (generation === operationGeneration.current) onRecover(session)
      })
      .catch(() => {
        if (generation === operationGeneration.current) setError('恢复失败，请重试')
      })
      .finally(() => {
        if (generation === operationGeneration.current) setBusy(false)
      })
  }

  const confirmOperation = (): void => {
    if (confirmation === undefined || busy) return
    const target = confirmation
    listGeneration.current += 1
    detailGeneration.current += 1
    const generation = ++operationGeneration.current
    setLoading(false)
    setDetailLoading(false)
    setBusy(true)
    setError(undefined)
    const operation = target.kind === 'clear'
      ? window.aiDebates.history.clear()
      : window.aiDebates.history.delete({ sessionId: target.sessionId })
    void operation.then((result) => {
      if (generation !== operationGeneration.current) return
      if (target.kind === 'delete' && (!('deleted' in result) || !result.deleted)) {
        throw new Error('History record was not deleted')
      }
      if (target.kind === 'clear') {
        setSessions([])
        setSelected(undefined)
      } else {
        setSessions((current) => current.filter(({ id }) => id !== target.sessionId))
        if (selected?.id === target.sessionId) setSelected(undefined)
      }
      setConfirmation(undefined)
    }).catch(() => {
      if (generation !== operationGeneration.current) return
      setError(target.kind === 'clear' ? '清空失败，请重试' : '删除失败，请重试')
      setConfirmation(undefined)
    }).finally(() => {
      if (generation === operationGeneration.current) setBusy(false)
    })
  }

  return <section className="history-page" aria-labelledby="history-title">
    <header className="page-heading history-heading">
      <div><p className="eyebrow">历史记录</p><h1 id="history-title">辩论档案</h1><p>查看、导出或恢复过去的辩论。</p></div>
      <button type="button" className="button danger" disabled={sessions.length === 0 || busy}
        onClick={() => setConfirmation({ kind: 'clear' })}>清空历史记录</button>
    </header>
    <form className="history-search" role="search" onSubmit={(event) => { event.preventDefault(); loadList(query) }}>
      <label htmlFor="history-search">搜索历史记录</label>
      <input id="history-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="submit" className="button secondary" disabled={loading || busy}>搜索</button>
    </form>
    {error ? <p className="page-error" role="alert">{error}</p> : null}
    {loading && sessions.length === 0 ? <p className="history-empty" role="status">正在加载历史记录…</p> : null}
    {!loading && error && sessions.length === 0 ? <button type="button" className="button secondary" onClick={() => loadList(query)}>重试</button> : null}
    {!loading && !error && sessions.length === 0 ? <div className="history-empty"><h2>暂无历史记录</h2><p>完成或暂停一场辩论后，会在这里显示。</p></div> : null}
    {sessions.length > 0 ? <div className="history-layout">
      <aside><HistoryList sessions={sessions} selectedId={selected?.id} busy={busy}
        selectionDisabled={busy && confirmation !== undefined}
        onSelect={selectSession} onDelete={(sessionId) => setConfirmation({ kind: 'delete', sessionId })} /></aside>
      <main>{detailLoading ? <p className="history-empty" role="status">正在加载详情…</p>
        : selected === undefined ? <div className="history-empty"><h2>选择一条记录</h2><p>详情将在此处显示。</p></div>
          : <HistoryDetail session={selected} busy={busy} notice={notice}
              onExport={exportSelected} onDelete={() => setConfirmation({ kind: 'delete', sessionId: selected.id })}
              onRecover={recoverSelected} />}</main>
    </div> : null}
    {confirmation ? <ConfirmDialog
      title={confirmation.kind === 'clear' ? '清空历史记录' : '删除历史记录'}
      message={confirmation.kind === 'clear' ? '此操作会删除全部辩论记录，但不会删除角色配置。' : '确定删除这条辩论记录吗？'}
      confirmLabel={confirmation.kind === 'clear' ? '确认清空' : '确认删除'} busy={busy}
      onCancel={() => setConfirmation(undefined)} onConfirm={confirmOperation} /> : null}
  </section>
}
