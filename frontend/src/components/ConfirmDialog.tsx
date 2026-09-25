import { Suspense } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { lazyWithReload } from '@/lib/lazyWithReload'

// The typed / in-place-pending variant is rare (deleting a project) and this
// dialog sits on the first load through useConfirm, so its body is its own chunk.
const ConfirmDialogGuardedContent = lazyWithReload(() => import('./ConfirmDialogGuardedContent'))

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  variant?: 'danger' | 'primary'
  onConfirm: () => void
  onCancel: () => void
  /**
   * Typed confirmation: Confirm arms only once exactly this text is typed —
   * for the actions that cannot be undone (WS-10).
   */
  requireText?: string
  /**
   * Confirm does not close the dialog: the caller runs the action and closes
   * it on success, meanwhile `pending` and `error` render in place (WS-9).
   */
  stayOpen?: boolean
  pending?: boolean
  /** The failed attempt's error, shown under the message. */
  error?: unknown
  /** Lead-in for the error line, e.g. "Could not delete the project". */
  errorPrefix?: string
  /** Confirm's label while `pending`. */
  pendingLabel?: string
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  variant = 'danger',
  onConfirm,
  onCancel,
  requireText,
  stayOpen = false,
  pending = false,
  error,
  errorPrefix,
  pendingLabel,
}: Props) {
  if (requireText !== undefined || stayOpen) {
    return (
      <AlertDialog
        open={open}
        onOpenChange={v => {
          // Esc and the overlay come through here too; a request in flight is
          // not abandoned by closing the dialog over it.
          if (!v && !pending) onCancel()
        }}
      >
        {open && (
          <Suspense fallback={null}>
            <ConfirmDialogGuardedContent
              title={title}
              message={message}
              confirmLabel={confirmLabel}
              variant={variant}
              requireText={requireText}
              pending={pending}
              error={error}
              errorPrefix={errorPrefix}
              pendingLabel={pendingLabel}
              onConfirm={onConfirm}
            />
          </Suspense>
        )}
      </AlertDialog>
    )
  }
  return (
    <AlertDialog open={open} onOpenChange={v => { if (!v) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={variant === 'danger' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
