export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="desktop-shell">
      <header className="topbar">
        <div><span className="brand-mark">AI</span><strong>模型辩论场</strong></div>
        <span className="desktop-status"><i /> 本地桌面版</span>
      </header>
      <aside className="sidebar" aria-label="主导航">
        <p className="nav-label">工作区</p>
        <nav><a className="nav-item active" aria-current="page" href="#configuration">角色配置</a></nav>
        <div className="sidebar-note"><strong>凭据保护</strong><span>API Key 由 Windows Credential Manager 保存。</span></div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  )
}
