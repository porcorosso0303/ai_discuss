import { useEffect, useRef } from 'react'

import type { DebateMessage, RoleConfig } from '../../../shared/domain'
import type { DebateDraft } from '../hooks/use-debate-events'
import { MessageBubble } from './MessageBubble'

export function Timeline({ roles, messages, drafts, revision }: {
  roles: [RoleConfig, RoleConfig]
  messages: DebateMessage[]
  drafts: Record<string, DebateDraft>
  revision: number
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    if (!nearBottom.current) return
    const frame = requestAnimationFrame(() => {
      const element = container.current
      if (element === null) return
      if (typeof element.scrollTo === 'function') element.scrollTo({ top: element.scrollHeight })
      else element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [revision])
  return <div className="debate-timeline" role="log" aria-label="辩论对话" ref={container}
    onScroll={(event) => {
      const target = event.currentTarget
      nearBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 80
    }}>
    <div className="debate-columns">
      {roles.map((role, index) => <section key={role.roleId} className={`debate-column role-${index === 0 ? 'a' : 'b'}`} aria-label={`${role.name} 发言列`}>
        <header className="column-heading"><span className="role-letter">{index === 0 ? 'A' : 'B'}</span><div><strong>{role.name}</strong><span>{role.provider} · {role.model}</span></div></header>
        <div className="column-messages">
          {messages.filter((message) => message.roleId === role.roleId).map((message) => <MessageBubble key={message.id} role={role} message={message} />)}
          {Object.values(drafts).filter((draft) => draft.roleId === role.roleId).sort((a, b) => a.turn - b.turn)
            .map((draft) => <MessageBubble key={`${draft.roleId}:${draft.turn}`} role={role} draft={draft} />)}
        </div>
      </section>)}
    </div>
  </div>
}
