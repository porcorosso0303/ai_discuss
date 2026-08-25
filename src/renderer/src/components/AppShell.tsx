type AppRoute = 'configuration' | 'debate'

export function AppShell({ children, active = 'configuration', configurationDisabled = false,
  debateDisabled = false, onNavigate }: {
  children: React.ReactNode
  active?: AppRoute
  configurationDisabled?: boolean
  debateDisabled?: boolean
  onNavigate?(route: AppRoute): void
}): React.JSX.Element {
  return (
    <div className="desktop-shell">
      <header className="topbar">
        <div><span className="brand-mark">AI</span><strong>模型辩论场</strong></div>
        <span className="desktop-status"><i /> 本地桌面版</span>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <p className="nav-label">工作区</p>
        <nav>
          <button type="button" className={`nav-item${active === 'configuration' ? ' active' : ''}`}
            aria-current={active === 'configuration' ? 'page' : undefined}
            disabled={configurationDisabled || active === 'configuration'} onClick={() => onNavigate?.('configuration')}>角色配置</button>
          <button type="button" className={`nav-item${active === 'debate' ? ' active' : ''}`}
            aria-current={active === 'debate' ? 'page' : undefined}
            disabled={debateDisabled || active === 'debate'} onClick={() => onNavigate?.('debate')}>辩论现场</button>
          <button type="button" className="nav-item disabled" disabled>历史记录</button>
        </nav>
        <div className="sidebar-note"><strong>凭据保护</strong><span>API Key 由 Windows Credential Manager 保存。</span></div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  )
}
