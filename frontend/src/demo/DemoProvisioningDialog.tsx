/**
 * Demo-provisioning progress + failure dialog (tripl-2su6.9).
 *
 * Shows staged progress during the single blocking create and an inline,
 * human error with a Retry action on 500. Accessibility:
 *  - Radix Dialog traps focus and restores it on close;
 *  - an `aria-live` region announces the current phase and the final result;
 *  - the dialog cannot be dismissed while a create is in flight (no accidental
 *    abandon of an in-progress provision).
 */

import { Check, Loader2 } from 'lucide-react'
import { ApiError } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getErrorMessage } from '@/lib/utils'
import { PROVISIONING_PHASES } from './provisioningPhases'
import type { ProvisioningStatus } from './useDemoProvisioning'

interface DemoProvisioningDialogProps {
  status: ProvisioningStatus
  phaseIndex: number
  error: unknown
  timedOut: boolean
  onRetry: () => void
  onCancel: () => void
  onClose: () => void
}

export function DemoProvisioningDialog({
  status,
  phaseIndex,
  error,
  timedOut,
  onRetry,
  onCancel,
  onClose,
}: DemoProvisioningDialogProps) {
  const open = status === 'provisioning' || status === 'error' || status === 'success'
  const isProvisioning = status === 'provisioning'
  const isError = status === 'error'

  const errorMessage = getErrorMessage(error)
  // A support reference the user can quote. The backend echoes the request id on
  // the response header, so ApiError carries it for the demo 500 path.
  const requestId = error instanceof ApiError ? error.requestId : undefined

  // On failure the role="alert" block below is the single live announcer, so the
  // polite status region stays silent — otherwise a screen reader reads the same
  // "failed" sentence twice (once assertive via the alert, once polite here).
  const announcement = isError
    ? null
    : status === 'success'
      ? 'Demo workspace is ready.'
      : `Generating demo workspace — ${PROVISIONING_PHASES[phaseIndex]?.label ?? 'Working'}`

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return
        // A create in flight is abandonable, not un-dismissable: a stalled
        // connection used to leave a page reload as the only way out
        // (tripl-2su6.15). Escape / the close button / an outside click cancel
        // the request; anything else just closes.
        if (isProvisioning) onCancel()
        else onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isError ? 'Demo generation failed' : 'Generating demo workspace'}
          </DialogTitle>
          <DialogDescription>
            {isError
              ? timedOut
                ? // Honesty: a timeout aborts OUR request; the server may well be
                  // seeding still. Promising a rollback here would be a lie.
                  'The request took too long and was stopped. The demo may still be finishing on the server — check your projects list before creating another.'
                : 'Nothing was left behind — the partial demo was rolled back. You can try again.'
              : 'Seeding a fully-populated workspace with synthetic data. This takes a few seconds.'}
          </DialogDescription>
        </DialogHeader>

        {/* Polite live region for progress + success; the failure path is
            announced once by the role="alert" block below (never both). */}
        {announcement !== null && (
          <p className="sr-only" aria-live="polite" role="status">
            {announcement}
          </p>
        )}

        {isError ? (
          <div
            role="alert"
            className="space-y-1 rounded-lg border px-3 py-2.5 text-[12.5px] leading-[1.45]"
            style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--fg)' }}
          >
            <p>{errorMessage}</p>
            {requestId ? (
              <p className="font-mono text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                Reference: {requestId}
              </p>
            ) : null}
          </div>
        ) : (
          <ol className="space-y-1.5">
            {PROVISIONING_PHASES.map((phase, index) => {
              const state =
                status === 'success' || index < phaseIndex
                  ? 'done'
                  : index === phaseIndex
                    ? 'active'
                    : 'pending'
              return (
                <li key={phase.id} className="flex items-center gap-2.5 text-[12.5px]">
                  <PhaseIcon state={state} />
                  <span
                    style={{
                      color: state === 'pending' ? 'var(--fg-faint)' : 'var(--fg)',
                      fontWeight: state === 'active' ? 600 : 400,
                    }}
                  >
                    {phase.label}
                  </span>
                </li>
              )
            })}
          </ol>
        )}

        <DialogFooter>
          {isError ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" onClick={onRetry}>
                Try again
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={onCancel} disabled={!isProvisioning}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PhaseIcon({ state }: { state: 'done' | 'active' | 'pending' }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--success-soft)', color: 'var(--success)' }}
      >
        <Check className="h-3 w-3" />
      </span>
    )
  }
  if (state === 'active') {
    return <Loader2 aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
      style={{ borderColor: 'var(--border)' }}
    />
  )
}
