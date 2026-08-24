import type { RoleDraft } from '../state/app-state'
import { selectedModel } from '../state/app-state'

interface Props {
  draft: RoleDraft
  apiKey: string
  onApiKey(value: string): void
  onChange(change: Partial<RoleDraft>): void
}

export function ProviderFields({ draft, apiKey, onApiKey, onChange }: Props): React.JSX.Element {
  const capability = selectedModel(draft)
  const samplingVisible = draft.provider !== 'openai' && draft.thinking === false
  return (
    <>
      {draft.provider === 'openai' ? null : (
        <>
          <label className="field">API Key
            <input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => onApiKey(event.target.value)} placeholder={draft.hasStoredSecret ? '已保存凭据（留空继续使用）' : '输入 API Key'} />
          </label>
          <details className="advanced">
            <summary>高级设置</summary>
            <label className="field">Base URL
              <input value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} />
            </label>
          </details>
        </>
      )}

      <div className="model-row">
        <label className="field grow">模型
          <select value={draft.model} onChange={(event) => onChange({ model: event.target.value })} disabled={!draft.capabilities?.models.length}>
            <option value="">先获取模型</option>
            {draft.capabilities?.models.map((model) => <option key={model.id} value={model.id}>{model.displayName ?? model.id}</option>)}
          </select>
        </label>
      </div>

      {capability?.reasoningEfforts.length ? (
        <label className="field">思考强度
          <select value={draft.effort} onChange={(event) => onChange({ effort: event.target.value })}>
            {capability.reasoningEfforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>
      ) : null}

      {draft.provider !== 'openai' && capability?.thinking !== null && capability?.thinking !== undefined ? (
        <label className="check-field"><input type="checkbox" checked={draft.thinking ?? false} onChange={(event) => onChange({
          thinking: event.target.checked,
          effort: event.target.checked ? (capability.defaultReasoningEffort ?? capability.reasoningEfforts[0] ?? 'none') : 'none',
          thinkingKeep: event.target.checked && capability.thinking?.keepSupported ? 'all' : undefined,
          sampling: event.target.checked ? {} : Object.fromEntries(capability.samplingParameters.flatMap((parameter) => parameter.default === undefined ? [] : [[parameter.name, parameter.default]]))
        })} />思考模式</label>
      ) : null}

      {draft.model ? (
        <details className="advanced">
          <summary>高级参数</summary>
          {draft.provider === 'kimi' ? (
            <label className="field">最大输出 Token
              <input type="number" min="1" value={draft.maxOutputTokens} onChange={(event) => onChange({ maxOutputTokens: Number(event.target.value) })} />
            </label>
          ) : draft.provider === 'deepseek' ? (
            <label className="field">最大输出 Token
              <input type="number" min="1" value={draft.maxOutputTokens} onChange={(event) => onChange({ maxOutputTokens: Number(event.target.value) })} />
            </label>
          ) : null}
          {samplingVisible ? capability?.samplingParameters.map((parameter) => (
            <label className="field" key={parameter.name}>{parameter.name}
              <input type="number" min={parameter.min} max={parameter.max} step="0.1" value={draft.sampling[parameter.name] ?? ''} onChange={(event) => onChange({
                sampling: { ...draft.sampling, [parameter.name]: Number(event.target.value) }
              })} />
            </label>
          )) : null}
        </details>
      ) : null}
    </>
  )
}
