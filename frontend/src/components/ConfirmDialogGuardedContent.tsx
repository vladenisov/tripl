import { useId, useState } from 'react'
import {
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getErrorMessage } from '@/lib/utils'

/**
 * ConfirmDialog's guarded body: an optional typed confirmation, and a Confirm
 * that does not close the dialog. A plain submit Button rather than
 * AlertDialogAction, which would close on click — the caller closes it once
 * the action has succeeded, and a failure renders here instead of vanishing
 * with the dialog.
 */
export default function ConfirmDialogGuardedContent({
  title,
  message,
  confirmLabel,
  variant,
  requireText,
  pending,
  error,
  errorPrefix = 'That did not work',
  pendingLabel,
  onConfirm,
}: {
  title: string
  message: string
  confirmLabel: string
  variant: 'danger' | 'primary'
  requireText?: string
  pending: boolean
  error?: unknown
  errorPrefix?: string
  pendingLabel?: string
  onConfirm: () => void
}) {
  const [typed, setTyped] = useState('')
  const inputId = useId()
  const armed = requireText === undefined || typed.trim() === requireText
  return (
    <AlertDialogContent>
      <form
        className="grid gap-4"
        onSubmit={event => {
          event.preventDefault()
          if (armed && !pending) onConfirm()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        {requireText !== undefined && (
          <div className="grid gap-2">
            <label htmlFor={inputId} className="text-[12.5px]">
              Type <span className="mono font-semibold">{requireText}</span> to confirm
            </label>
            <Input
              id={inputId}
              value={typed}
              onChange={event => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mono"
              disabled={pending}
            />
          </div>
        )}
        {error != null && !pending && (
          <p role="alert" className="m-0 text-[12.5px]" style={{ color: 'var(--danger)' }}>
            {errorPrefix}: {getErrorMessage(error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel type="button" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="submit"
            variant={variant === 'danger' ? 'destructive' : 'default'}
            disabled={!armed || pending}
          >
            {pending ? (pendingLabel ?? `${confirmLabel}…`) : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </form>
    </AlertDialogContent>
  )
}
