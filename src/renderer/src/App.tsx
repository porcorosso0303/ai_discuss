import { useCallback, useState } from 'react'

import type { DebateSession, RoleConfig } from '../../shared/domain'
import { AppShell, type AppRoute } from './components/AppShell'
import { DebatePage } from './pages/DebatePage'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { HistoryPage } from './pages/HistoryPage'
import { AppStateProvider, toRoleConfig, useAppState } from './state/app-state'

function AppContent(): React.JSX.Element {
  const { roles, canContinue } = useAppState()
  const [route, setRoute] = useState<AppRoute>('configuration')
  const [debateActive, setDebateActive] = useState(false)
  const [initialSession, setInitialSession] = useState<DebateSession>()
  const [debateRoles, setDebateRoles] = useState<[RoleConfig, RoleConfig]>()
  const roleA = toRoleConfig(roles['role-a'])
  const roleB = toRoleConfig(roles['role-b'])
  const keepLatestSession = useCallback((session: DebateSession): void => {
    setInitialSession((current) => current === undefined || current.id === session.id ? session : current)
  }, [])
  const enterDebate = (): void => {
    if (canContinue && roleA !== undefined && roleB !== undefined) {
      setInitialSession(undefined)
      setDebateRoles([roleA, roleB])
      setRoute('debate')
    }
  }
  const navigate = (next: AppRoute): void => {
    if (debateActive && next !== 'debate') return
    if (next === 'configuration') {
      setInitialSession(undefined)
      setRoute(next)
      return
    }
    if (next === 'history') {
      setRoute('history')
      return
    }
    if (initialSession !== undefined && debateRoles !== undefined) setRoute('debate')
    else enterDebate()
  }
  return <AppShell active={route} onNavigate={navigate} configurationDisabled={debateActive}
    debateDisabled={debateRoles === undefined && (!canContinue || roleA === undefined || roleB === undefined)}
    historyDisabled={debateActive}>{route === 'debate' && debateRoles !== undefined
    ? <DebatePage roles={debateRoles} initialSession={initialSession} onActivityChange={setDebateActive}
        onSessionChange={keepLatestSession}
        onBack={() => { setInitialSession(undefined); setRoute('configuration') }} />
    : route === 'history'
      ? <HistoryPage onRecover={(session) => {
          setDebateRoles(session.setup.roles)
          setInitialSession(session)
          setRoute('debate')
        }} />
      : <ConfigurationPage onContinue={enterDebate} />}</AppShell>
}

export default function App(): React.JSX.Element {
  return <AppStateProvider><AppContent /></AppStateProvider>
}
