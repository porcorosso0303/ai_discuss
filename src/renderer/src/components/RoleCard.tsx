import { useState } from 'react'

import type { RoleId } from '../../../shared/domain'
import { useAppState } from '../state/app-state'
import { ConnectionBadge } from './ConnectionBadge'
import { ProviderFields } from './ProviderFields'

export function RoleCard({ roleId }: { roleId: RoleId }): React.JSX.Element {
  const { roles, auth, updateRole, switchProvider, discover, test, deleteSecret, startLogin, logout } = useAppState()
  const draft = roles[roleId]
  const [apiKey, setApiKey] = useState('')
  const label = roleId === 'role-a' ? 'A' : 'B'
  const handleTest = async (): Promise<void> => {
    await test(roleId, apiKey, () => setApiKey(''))
  }
  return (
    <section className={`role-card role-${label.toLowerCase()}`} aria-label={`角色 ${label} 配置`}>
      <div className="role-card-header">
        <div><span className="role-letter">{label}</span><div><h2>角色 {label}</h2><p>{label === 'A' ? '率先陈述或回应观点' : '与角色 A 展开交流'}</p></div></div>
        <ConnectionBadge state={draft.connection} />
      </div>
      <fieldset disabled={draft.busy}>
        <legend className="sr-only">角色 {label} 参数</legend>
        <div className="field-grid">
          <label className="field">角色名称<input value={draft.name} maxLength={100} onChange={(event) => updateRole(roleId, { name: event.target.value })} /></label>
          <label className="field">服务商
            <select value={draft.provider} onChange={(event) => { setApiKey(''); switchProvider(roleId, event.target.value as 'openai' | 'kimi' | 'deepseek') }}>
              <option value="openai">OpenAI / Codex</option><option value="kimi">Kimi</option><option value="deepseek">DeepSeek</option>
            </select>
          </label>
        </div>
        <label className="field">角色立场<textarea value={draft.personaOrStance} maxLength={4000} rows={3} onChange={(event) => updateRole(roleId, { personaOrStance: event.target.value })} placeholder="可选：描述立场、风格或论证重点" /></label>
        {draft.provider === 'openai' ? (
          <div className="auth-panel"><div><strong>ChatGPT 账号</strong><span>{auth.status === 'signed-in' ? `已登录${auth.accountLabel ? ` · ${auth.accountLabel}` : ''}` : auth.status === 'signing-in' ? '正在登录…' : '尚未登录'}</span></div>
            {auth.status === 'signed-in'
              ? <button type="button" className="button secondary" onClick={() => void logout()}>退出登录</button>
              : <button type="button" className="button secondary" disabled={auth.status === 'signing-in'} onClick={() => void startLogin()}>使用 ChatGPT 登录</button>}
          </div>
        ) : null}
        <ProviderFields draft={draft} apiKey={apiKey} onApiKey={(value) => {
          setApiKey(value)
          updateRole(roleId, {})
        }} onChange={(change) => updateRole(roleId, change)} />
        {draft.provider !== 'openai' && draft.hasStoredSecret ? (
          <button type="button" className="credential-delete" onClick={() => void deleteSecret(roleId)}>删除已保存凭据</button>
        ) : null}
        {draft.error ? <p className="field-error" role="alert">{draft.error}</p> : null}
        <div className="card-actions">
          <button type="button" className="button secondary" onClick={() => void discover(roleId, apiKey, () => setApiKey(''))}>{draft.busy ? '请稍候…' : '获取模型'}</button>
          <button type="button" className="button primary" onClick={() => void handleTest()} disabled={!draft.model}>{draft.connection === 'testing' ? '测试中…' : '测试连接'}</button>
        </div>
      </fieldset>
    </section>
  )
}
