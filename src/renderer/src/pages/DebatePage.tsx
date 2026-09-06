import { useEffect, useRef, useState } from 'react'

import type { DebateSession, DebateSetup, RoleConfig } from '../../../shared/domain'
import { DebateControls } from '../components/DebateControls'
import { DebateSetup as DebateSetupForm } from '../components/DebateSetup'
import { ResultCard } from '../components/ResultCard'
import { Timeline } from '../components/Timeline'
import { useDebateEvents } from '../hooks/use-debate-events'

const phaseLabels: Record<string, string> = {
  starting: '正在启动', idle: '等待开始', validating: '正在校验', running: '辩论中', pausing: '正在暂停',
  paused: '已暂停', completed: '已完成', stopped: '已停止', unresolved: '未决', refused: '模型拒绝', failed: '调用失败'
}

const terminalPhases = new Set(['completed', 'stopped', 'unresolved', 'refused', 'failed'])

export function DebatePage({ roles, initialSession, onBack, onActivityChange, onSessionChange }: {
  roles: [RoleConfig, RoleConfig]
  initialSession?: DebateSession
  onBack(): void
  onActivityChange?(active: boolean): void
  onSessionChange?(session: DebateSession): void
}): React.JSX.Element {
  const [state, dispatch] = useDebateEvents(initialSession)
  const [started, setStarted] = useState(initialSession !== undefined)
  const [startBusy, setStartBusy] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [controlError, setControlError] = useState<string>()
  const startAttempt = useRef(0)
  const debateActive = started && !terminalPhases.has(state.phase)

  useEffect(() => {
    onActivityChange?.(debateActive)
  }, [debateActive, onActivityChange])
  useEffect(() => () => onActivityChange?.(false), [onActivityChange])
  useEffect(() => {
    if (state.session !== undefined) onSessionChange?.(state.session)
  }, [onSessionChange, state.session])

  const requestStart = (setup: DebateSetup): void => {
    const attempt = ++startAttempt.current
    setStartBusy(true)
    setControlError(undefined)
    dispatch({ type: 'begin', setup, attempt })
    void window.aiDebates.debate.start({ setup }).then(({ session }) => {
      dispatch({ type: 'session', session, attempt })
    }).catch(() => {
      dispatch({ type: 'start-error', attempt, message: '无法启动辩论，请重试' })
    }).finally(() => {
      if (startAttempt.current === attempt) setStartBusy(false)
    })
  }

  const start = (setup: DebateSetup): void => {
    if (startBusy || started) return
    setStarted(true)
    requestStart(setup)
  }

  const control = (action: 'pause' | 'resume' | 'stop' | 'retryCurrentTurn'): void => {
    if (state.sessionId === undefined || controlBusy) return
    if (action === 'stop') dispatch({ type: 'discard-drafts' })
    if (action === 'resume') dispatch({ type: 'recovery-resume-requested' })
    setControlBusy(true)
    setControlError(undefined)
    void window.aiDebates.debate[action]({ sessionId: state.sessionId }).catch(() => {
      if (action === 'resume') dispatch({ type: 'recovery-resume-rejected' })
      setControlError('操作失败，请重试')
    }).finally(() => setControlBusy(false))
  }

  const retry = (): void => {
    if (state.startRejected && state.setup !== undefined && !startBusy) requestStart(state.setup)
    else if (state.sessionId !== undefined) control('retryCurrentTurn')
    else if (state.setup !== undefined && !startBusy) requestStart(state.setup)
  }

  if (!started) return <DebateSetupForm roles={roles} busy={startBusy} onStart={start} onBack={onBack} />
  const currentRole = roles.find(({ roleId }) => roleId === state.currentRoleId)
  return <section className="debate-page live-debate-page" aria-labelledby="live-debate-title">
    <header className="live-heading"><div><p className="eyebrow">第三步</p><h1 id="live-debate-title">{state.setup?.topic}</h1></div>
      <DebateControls phase={state.phase} enabled={state.sessionId !== undefined}
        canRetry={state.recoveryValidationFailed ? false : state.startRejected
          ? !startBusy && state.setup !== undefined
          : state.sessionId !== undefined}
        retryLabel={state.startRejected || state.sessionId === undefined ? '重新启动辩论' : '重试当前轮'} busy={controlBusy}
        onPause={() => control('pause')} onResume={() => control('resume')} onStop={() => control('stop')}
        onRetry={retry} /></header>
    <div className="debate-status-band" role="status"><span className={`phase-badge phase-${state.phase}`}>{phaseLabels[state.phase]}</span>
      <span>第 {state.currentTurn} / {state.setup?.maxTurns ?? 100} 轮</span>
      <span>{currentRole ? `当前：${currentRole.name}` : '等待首位辩手'}</span></div>
    {controlError || state.error ? <p className="page-error live-error" role="alert">{controlError ?? state.error}</p> : null}
    {state.recoveryValidationFailed
      ? <p className="page-error live-error" role="alert">模型配置已变化，请返回角色配置后重新测试</p> : null}
    {initialSession !== undefined && state.phase === 'paused'
      ? <p className="recovered-note" role="status">已恢复，等待用户继续</p> : null}
    {state.warnings.map((warning) => <p className="debate-warning" role="status" key={warning.id}>提示：{warning.message}</p>)}
    {state.compressedRoles.length > 0 ? <p className="context-note">较早对话已压缩，以便继续辩论。</p> : null}
    <Timeline roles={roles} messages={state.messages} drafts={state.drafts} revision={state.contentRevision} />
    <ResultCard session={state.session} phase={state.phase} roles={roles} onBack={onBack} />
  </section>
}
