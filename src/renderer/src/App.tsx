import { useState } from 'react'

import { AppShell } from './components/AppShell'
import { DebatePage } from './pages/DebatePage'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { AppStateProvider, toRoleConfig, useAppState } from './state/app-state'

function AppContent(): React.JSX.Element {
  const { roles, canContinue } = useAppState()
  const [route, setRoute] = useState<'configuration' | 'debate'>('configuration')
  const roleA = toRoleConfig(roles['role-a'])
  const roleB = toRoleConfig(roles['role-b'])
  const enterDebate = (): void => {
    if (canContinue && roleA !== undefined && roleB !== undefined) setRoute('debate')
  }
  return <AppShell active={route}>{route === 'debate' && roleA !== undefined && roleB !== undefined
    ? <DebatePage roles={[roleA, roleB]} onBack={() => setRoute('configuration')} />
    : <ConfigurationPage onContinue={enterDebate} />}</AppShell>
}

export default function App(): React.JSX.Element {
  return <AppStateProvider><AppContent /></AppStateProvider>
}
