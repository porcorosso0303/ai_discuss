import type { DebateSessionState } from '../../../shared/domain'
import type { DebateSessionSummary } from '../../../shared/ipc'

const stateLabels: Record<DebateSessionState, string> = {
  idle: '等待开始', validating: '校验中', running: '进行中', pausing: '暂停中', paused: '已暂停',
  completed: '已完成', stopped: '已停止', unresolved: '未决', refused: '模型拒绝', failed: '调用失败'
}

const formatTime = (value: string): string => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
}).format(new Date(value))

export function HistoryList({ sessions, selectedId, busy, selectionDisabled, onSelect, onDelete }: {
  sessions: DebateSessionSummary[]
  selectedId?: string
  busy: boolean
  selectionDisabled: boolean
  onSelect(sessionId: string): void
  onDelete(sessionId: string): void
}): React.JSX.Element {
  return <ol className="history-list" aria-label="历史记录列表">
    {sessions.map((session) => <li key={session.id}>
      <button type="button" className={`history-select${selectedId === session.id ? ' selected' : ''}`}
        aria-label={`查看${session.topic}`} aria-pressed={selectedId === session.id}
        disabled={selectionDisabled}
        onClick={() => onSelect(session.id)}>
        <strong>{session.topic}</strong>
        <span>{stateLabels[session.state]} · {session.currentTurn} 轮</span>
        <time dateTime={session.updatedAt}>{formatTime(session.updatedAt)}</time>
      </button>
      <button type="button" className="history-row-delete" aria-label={`删除${session.topic}`}
        disabled={busy} onClick={() => onDelete(session.id)}>删</button>
    </li>)}
  </ol>
}
