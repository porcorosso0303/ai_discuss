import type { DebateSession, RoleConfig } from '../../../shared/domain'

export function ResultCard({ session, phase, roles, onBack }: {
  session?: DebateSession
  phase: string
  roles: [RoleConfig, RoleConfig]
  onBack(): void
}): React.JSX.Element | null {
  const isTerminal = ['completed', 'stopped', 'unresolved', 'refused', 'failed'].includes(phase)
  if (!isTerminal) return null
  const winner = roles.find(({ roleId }) => roleId === session?.winnerRoleId)
  const reason = session?.terminationReason
  const title = reason === 'conceded' ? `${winner?.name ?? '一方'} 获胜`
    : reason === 'agreed' ? '双方达成一致'
      : reason === 'max-turns' || phase === 'unresolved' ? '达到轮次上限，尚未决出结果'
        : reason === 'user-stopped' ? '辩论已停止'
          : reason === 'provider-refusal' ? '模型拒绝继续'
            : reason === 'call-failed' || phase === 'failed' ? '模型调用失败' : '辩论已结束'
  return <section className="result-card" role="region" aria-label="辩论结果"><p className="eyebrow">辩论结果</p><h2>{title}</h2>
    {reason === 'conceded' ? <p>对方已承认落败。</p> : null}
    <div><button type="button" className="button secondary" onClick={onBack}>返回角色配置</button>
      <button type="button" className="button secondary" disabled title="将在历史记录功能中提供">查看历史</button></div>
  </section>
}
