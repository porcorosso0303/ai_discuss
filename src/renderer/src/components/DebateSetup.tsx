import { useState } from 'react'

import type { DebateSetup, RoleConfig, RoleId } from '../../../shared/domain'
import { debateSetupSchema } from '../../../shared/schemas'

export function DebateSetup({ roles, busy, onStart, onBack }: {
  roles: [RoleConfig, RoleConfig]
  busy: boolean
  onStart(setup: DebateSetup): void
  onBack(): void
}): React.JSX.Element {
  const [topic, setTopic] = useState('')
  const [firstSpeaker, setFirstSpeaker] = useState<RoleId>('role-a')
  const [maxTurns, setMaxTurns] = useState(100)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const result = debateSetupSchema.safeParse({ topic, roles, firstSpeaker, maxTurns })
    if (!result.success) {
      const next: Record<string, string> = {}
      for (const issue of result.error.issues) {
        const path = issue.path[0]
        if (path === 'topic') next.topic = topic.trim() === '' ? '请输入辩论话题' : '话题不能超过 10000 个字符'
        if (path === 'maxTurns') next.maxTurns = '轮次必须在 1 到 100 之间'
      }
      setErrors(next)
      return
    }
    setErrors({})
    onStart(result.data)
  }

  return (
    <section className="debate-page debate-setup-page" aria-labelledby="debate-setup-title">
      <div className="page-heading"><div><p className="eyebrow">第二步</p><h1 id="debate-setup-title">设置辩论话题</h1><p>确认主题、先发角色与轮次上限。</p></div><span className="step-indicator">2 / 3</span></div>
      <div className="setup-role-summary">
        {roles.map((role, index) => <article key={role.roleId} className={`role-summary role-${index === 0 ? 'a' : 'b'}`}>
          <span className="role-letter">{index === 0 ? 'A' : 'B'}</span>
          <div><strong>{role.name}</strong><span>{role.provider} · {role.model}</span></div>
        </article>)}
      </div>
      <form className="debate-setup-form" onSubmit={submit}>
        <div className="field"><label htmlFor="debate-topic">辩论话题</label>
          <textarea id="debate-topic" value={topic} maxLength={10_000} rows={5} aria-invalid={Boolean(errors.topic)} aria-describedby={errors.topic ? 'debate-topic-error' : undefined}
            onChange={(event) => { setTopic(event.target.value); setErrors((current) => ({ ...current, topic: '' })) }} />
          {errors.topic ? <span id="debate-topic-error" className="input-error" role="alert">{errors.topic}</span> : null}
        </div>
        <fieldset className="speaker-choice"><legend>谁先发言</legend>
          {roles.map((role, index) => <label key={role.roleId}>
            <input type="radio" name="first-speaker" value={role.roleId} checked={firstSpeaker === role.roleId}
              onChange={() => setFirstSpeaker(role.roleId)} />角色 {index === 0 ? 'A' : 'B'} · {role.name}
          </label>)}
        </fieldset>
        <label className="field turn-limit">最大轮次
          <input type="number" min={1} max={100} value={maxTurns}
            onChange={(event) => setMaxTurns(event.currentTarget.valueAsNumber)} />
          {errors.maxTurns ? <span className="input-error" role="alert">{errors.maxTurns}</span> : null}
        </label>
        <div className="setup-actions"><button type="button" className="button secondary" onClick={onBack}>返回角色配置</button>
          <button type="submit" className="button continue" disabled={busy}>{busy ? '正在启动…' : '开始辩论'}</button></div>
      </form>
    </section>
  )
}
