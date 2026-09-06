import type { DebateMessage, RoleConfig } from '../../../shared/domain'
import type { DebateDraft } from '../hooks/use-debate-events'

const statusLabels = { continue: '继续交锋', concede: '承认落败', agree: '达成一致' } as const

export function MessageBubble({ role, message, draft }: {
  role: RoleConfig
  message?: DebateMessage
  draft?: DebateDraft
}): React.JSX.Element {
  const speech = message?.speech ?? draft?.speech ?? ''
  const turn = message?.turn ?? draft?.turn
  return <article className={`message-bubble${draft ? ' draft' : ''}`} aria-label={`${role.name} 第 ${turn} 轮发言`}>
    <header><strong>{role.name}</strong><span>第 {turn} 轮</span></header>
    <p className="speech">{speech}</p>
    <footer>
      {draft ? <span className="draft-status">正在发言<span aria-hidden="true" className="typing-cursor" /></span> : null}
      {message ? <span className={`speech-status status-${message.status}`}>{statusLabels[message.status]}</span> : null}
      {message?.usage ? <small>{message.usage.totalTokens} tokens</small> : null}
    </footer>
  </article>
}
