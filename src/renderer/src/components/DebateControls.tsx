import type { DebateSessionState } from '../../../shared/domain'

export function DebateControls({ phase, enabled, canRetry, retryLabel, busy, onPause, onResume, onStop, onRetry }: {
  phase: DebateSessionState | 'starting'
  enabled: boolean
  canRetry: boolean
  retryLabel: string
  busy: boolean
  onPause(): void
  onResume(): void
  onStop(): void
  onRetry(): void
}): React.JSX.Element {
  const terminal = ['completed', 'stopped', 'unresolved', 'refused', 'failed'].includes(phase)
  return <div className="debate-controls" aria-label="辩论控制">
    {phase === 'paused'
      ? <button type="button" className="button primary" disabled={!enabled || busy} onClick={onResume} aria-label="继续辩论">继续</button>
      : <button type="button" className="button secondary" disabled={!enabled || busy || phase !== 'running'} onClick={onPause} aria-label="暂停辩论">暂停</button>}
    {phase === 'failed' ? <button type="button" className="button primary" disabled={!canRetry || busy} onClick={onRetry} aria-label={retryLabel}>{retryLabel}</button> : null}
    <button type="button" className="button danger" disabled={!enabled || busy || terminal} onClick={onStop} aria-label="停止辩论">停止</button>
  </div>
}
