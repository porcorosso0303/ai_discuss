import { RoleCard } from '../components/RoleCard'
import { useAppState } from '../state/app-state'

export function ConfigurationPage({ onContinue }: { onContinue?: () => void }): React.JSX.Element {
  const { canContinue, loadStatus, loadError, retryLoad } = useAppState()
  return (
    <section id="configuration" className="configuration-page" aria-labelledby="configuration-title">
      <div className="page-heading"><div><p className="eyebrow">第一步</p><h1 id="configuration-title">配置 AI 角色</h1><p>为两位辩手选择服务商和模型，并分别完成连接测试。</p></div><span className="step-indicator">1 / 3</span></div>
      <div className="credential-notice"><span aria-hidden="true">🔐</span><p><strong>凭据只保存在本机</strong><br />API Key 存入 Windows Credential Manager；OpenAI 使用 ChatGPT 登录，不会显示或回读密钥。</p></div>
      {loadStatus === 'loading' ? <p className="loading-status" role="status">正在加载配置…</p> : null}
      {loadError ? <div className="load-error"><p className="page-error" role="alert">{loadError}</p><button type="button" className="button secondary" onClick={retryLoad}>重试加载</button></div> : null}
      <div className="role-grid"><RoleCard roleId="role-a" /><RoleCard roleId="role-b" /></div>
      <footer className="page-footer"><p>两位角色连接测试通过后，即可继续。</p><button type="button" className="button continue" disabled={!canContinue || loadStatus !== 'ready'} onClick={onContinue}>进入辩论设置</button></footer>
    </section>
  )
}
