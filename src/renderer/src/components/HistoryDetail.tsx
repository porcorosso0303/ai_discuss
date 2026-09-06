import type { DebateSession } from '../../../shared/domain'
import { MessageBubble } from './MessageBubble'

const recoverable = new Set<DebateSession['state']>([
  'idle', 'validating', 'running', 'pausing', 'paused'
])

const resultText = (session: DebateSession): string => {
  if (session.terminationReason === 'agreed') return '双方达成一致'
  if (session.terminationReason === 'conceded') {
    return `${session.setup.roles.find(({ roleId }) => roleId === session.winnerRoleId)?.name ?? '对方'} 获胜`
  }
  if (session.terminationReason === 'max-turns') return '达到轮次上限，尚未决出结果'
  if (session.terminationReason === 'user-stopped') return '由用户停止'
  if (session.terminationReason === 'provider-refusal') return '模型拒绝继续'
  if (session.terminationReason === 'call-failed') return '模型调用失败'
  return '尚未结束'
}

export function HistoryDetail({ session, busy, notice, onExport, onDelete, onRecover }: {
  session: DebateSession
  busy: boolean
  notice?: string
  onExport(): void
  onDelete(): void
  onRecover(): void
}): React.JSX.Element {
  const totalUsage = session.messages.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0)
  const canRecover = recoverable.has(session.state)
  return <article className="history-detail">
    <header>
      <div><p className="eyebrow">历史详情</p><h2>{session.setup.topic}</h2></div>
      <div className="history-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onExport}>导出 Markdown</button>
        <button type="button" className="button danger" disabled={busy} onClick={onDelete}>删除此记录</button>
      </div>
    </header>
    {notice ? <p className="history-notice" role="status">{notice}</p> : null}
    {canRecover ? <section className="recovery-panel">
      <p><strong>可恢复的未完成辩论</strong><span>加载后不会自动继续</span></p>
      <button type="button" className="button primary" disabled={busy} onClick={onRecover}>加载并恢复</button>
    </section> : null}
    <section className="history-metadata" aria-label="配置快照">
      {session.setup.roles.map((role) => <div key={role.roleId}>
        <strong>{role.name}</strong><span>{role.provider} · {role.model}</span>
        <p>{role.personaOrStance || '未设置额外立场'}</p>
      </div>)}
    </section>
    <section aria-label="历史对话" className="history-messages">
      {session.messages.length === 0 ? <p className="muted">尚无已完成发言。</p> : session.messages.map((message) => {
        const role = session.setup.roles.find(({ roleId }) => roleId === message.roleId)
        return role === undefined ? null : <MessageBubble key={message.id} role={role} message={message} />
      })}
    </section>
    <footer className="history-result"><strong>{resultText(session)}</strong><span>总用量：{totalUsage} tokens</span></footer>
  </article>
}
