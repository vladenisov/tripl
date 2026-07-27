/**
 * Demo-provisioning progress + outcome dialog (tripl-2su6.9).
 *
 * Shows estimated staged progress during the single blocking create and an
 * inline, human error with a Retry action on 500. Accessibility:
 *  - Radix Dialog traps focus and restores it on close;
 *  - an `aria-live` region announces the current phase and the final result;
 *  - every terminal state (success, cancelled, failed) says so visibly and
 *    offers a positive action — never a disabled Cancel under a title that
 *    still claims work is in progress (tripl-jfm3.15).
 *
 * A create in flight is abandonable, and cancelling is honest about what the
 * server could do: the phase list is labelled an estimate rather than asserting
 * completed work the client cannot observe (tripl-jfm3.16), and a cancel that
 * arrived too late says the demo is going to appear (tripl-jfm3.12).
 */

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
import { ProvisioningPhaseList } from './ProvisioningPhaseList'
import { DEMO_PROVISION_ESTIMATE, PROVISIONING_PHASES } from './provisioningPhases'
import type { CancelOutcome, ProvisioningStatus } from './useDemoProvisioning'

interface DemoProvisioningDialogProps {
  status: ProvisioningStatus
  phaseIndex: number
  error: unknown
  timedOut: boolean
  cancelOutcome?: CancelOutcome | null
  onRetry: () => void
  onCancel: () => void
  onClose: () => void
}

/** Title + description for each state, so no state falls through to in-progress copy. */
function copyFor(
  status: ProvisioningStatus,
  timedOut: boolean,
  cancelOutcome: CancelOutcome | null,
): { title: string; description: string } {
  if (status === 'error') {
    return {
      title: 'Demo generation failed',
      description: timedOut
        ? // Honesty: a timeout aborts OUR request; the server may well be
          // seeding still. Promising a rollback here would be a lie.
          'The request took too long and was stopped. The demo may still be finishing on the server — check your projects list before creating another.'
        : 'Nothing was left behind — the partial demo was rolled back. You can try again.',
    }
  }
  if (status === 'success') {
    return {
      title: 'Demo workspace is ready',
      description: 'Seeded with synthetic events, metrics, monitors and alerts. Opening it now.',
    }
  }
  if (status === 'cancelling') {
    return {
      title: 'Cancelling demo generation',
      description: 'Asking the server to stop before the workspace is created…',
    }
  }
  if (status === 'cancelled') {
    return cancelOutcome === 'stopped'
      ? {
          title: 'Demo generation cancelled',
          description: 'The workspace was discarded — nothing was added to your projects.',
        }
      : {
          title: 'Too late to cancel',
          description:
            'The demo had already finished generating on the server, so it will appear in your projects list. Delete it from its banner if you do not want it.',
        }
  }
  return {
    title: 'Generating demo workspace',
    description: `Seeding a fully-populated workspace with synthetic data. This takes ${DEMO_PROVISION_ESTIMATE}.`,
  }
}

export function DemoProvisioningDialog({
  status,
  phaseIndex,
  error,
  timedOut,
  cancelOutcome = null,
  onRetry,
  onCancel,
  onClose,
}: DemoProvisioningDialogProps) {
  const open = status !== 'idle'
  const isProvisioning = status === 'provisioning'
  const isError = status === 'error'
  const isSuccess = status === 'success'
  const showPhases = !isError && status !== 'cancelled'

  const errorMessage = getErrorMessage(error)
  // A support reference the user can quote. The backend echoes the request id on
  // the response header, so ApiError carries it for the demo 500 path.
  const requestId = error instanceof ApiError ? error.requestId : undefined
  const { title, description } = copyFor(status, timedOut, cancelOutcome)

  // On failure the role="alert" block below is the single live announcer, so the
  // polite status region stays silent — otherwise a screen reader reads the same
  // "failed" sentence twice (once assertive via the alert, once polite here).
  const announcement = isError
    ? null
    : isProvisioning
      ? `Generating demo workspace — ${PROVISIONING_PHASES[phaseIndex]?.label ?? 'Working'}`
      : `${title}. ${description}`

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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Polite live region for progress + terminal outcomes; the failure path
            is announced once by the role="alert" block below (never both). */}
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
        ) : showPhases ? (
          <ProvisioningPhaseList phaseIndex={phaseIndex} complete={isSuccess} />
        ) : null}

        <DialogFooter>
          {isError ? (
            <>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button type="button" onClick={onRetry}>
                Try again
              </Button>
            </>
          ) : isProvisioning || status === 'cancelling' ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              disabled={status === 'cancelling'}
            >
              {status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : (
            <Button type="button" onClick={onClose}>
              {isSuccess ? 'Open demo' : 'Done'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
