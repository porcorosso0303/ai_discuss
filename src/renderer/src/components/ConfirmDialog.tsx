import { useEffect, useRef } from 'react'

export function ConfirmDialog({ title, message, confirmLabel, busy, onCancel, onConfirm }: {
  title: string
  message: string
  confirmLabel: string
  busy: boolean
  onCancel(): void
  onConfirm(): void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])
  return <div className="confirm-overlay">
    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <h2 id="confirm-title">{title}</h2>
      <p>{message}</p>
      <div>
        <button ref={cancelRef} type="button" className="button secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="button danger" disabled={busy} onClick={onConfirm}>
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </section>
  </div>
}
