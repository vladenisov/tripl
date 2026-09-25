import { useCallback, useState } from 'react'
import ConfirmDialog from '../components/ConfirmDialog'

export function useConfirm() {
  const [state, setState] = useState<{ title: string; message: string; variant?: 'danger' | 'primary'; confirmLabel?: string; resolve?: (v: boolean) => void } | null>(null)

  // Stable, so a hook that wraps it (useUnsavedChangesGuard) can memoise on it.
  const confirm = useCallback((opts: { title: string; message: string; variant?: 'danger' | 'primary'; confirmLabel?: string }) => {
    return new Promise<boolean>(resolve => {
      setState({ ...opts, resolve })
    })
  }, [])

  const dialog = state ? (
    <ConfirmDialog
      open
      title={state.title}
      message={state.message}
      variant={state.variant}
      confirmLabel={state.confirmLabel}
      onConfirm={() => { state.resolve?.(true); setState(null) }}
      onCancel={() => { state.resolve?.(false); setState(null) }}
    />
  ) : null

  return { confirm, dialog }
}
