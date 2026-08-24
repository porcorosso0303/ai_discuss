import { AppShell } from './components/AppShell'
import { ConfigurationPage } from './pages/ConfigurationPage'
import { AppStateProvider } from './state/app-state'

export default function App(): React.JSX.Element {
  return <AppStateProvider><AppShell><ConfigurationPage /></AppShell></AppStateProvider>
}
