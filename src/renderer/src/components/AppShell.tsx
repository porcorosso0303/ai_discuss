export function AppShell({ children, active = 'configuration' }: { children: React.ReactNode; active?: 'configuration' | 'debate' }): React.JSX.Element {
  return (
    <div className="desktop-shell">
      <header className="topbar">
        <div><span className="brand-mark">AI</span><strong>模型辩论场</strong></div>
        <span className="desktop-status"><i /> 本地桌面版</span>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <p className="nav-label">工作区</p>
        <nav>
          <a className={`nav-item${active === 'configuration' ? ' active' : ''}`} aria-current={active === 'configuration' ? 'page' : undefined} href="#configuration">角色配置</a>
          <a className={`nav-item${active === 'debate' ? ' active' : ''}`} aria-current={active === 'debate' ? 'page' : undefined} href="#debate">辩论现场</a>
          <a className="nav-item disabled" aria-disabled="true" href="#history" onClick={(event) => event.preventDefault()}>历史记录</a>
        </nav>
        <div className="sidebar-note"><strong>凭据保护</strong><span>API Key 由 Windows Credential Manager 保存。</span></div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  )
}
