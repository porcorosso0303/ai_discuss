import type { ConnectionState } from '../state/app-state'

const labels: Record<ConnectionState, string> = {
  idle: '未测试', testing: '测试中', passed: '连接正常', failed: '连接失败'
}

export function ConnectionBadge({ state }: { state: ConnectionState }): React.JSX.Element {
  return <span className={`connection-badge connection-${state}`} role="status">{labels[state]}</span>
}
