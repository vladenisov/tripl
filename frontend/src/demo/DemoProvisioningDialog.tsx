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
  onRetry: () => void
  onClose: () => void
}

export function DemoProvisioningDialog({
  status,
  phaseIndex,
  error,
  onRetry,
  onClose,
}: DemoProvisioningDialogProps) {
  const open = status === 'provisioning' || status === 'error' || status === 'success'
  const isProvisioning = status === 'provisioning'
  const isError = status === 'error'

  const announcement = isError
    ? `Demo generation failed: ${getErrorMessage(error)}`
    : status === 'success'
      ? 'Demo workspace is ready.'
      : `Generating demo workspace — ${PROVISIONING_PHASES[phaseIndex]?.label ?? 'Working'}`

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Block dismissal while a create is blocking; otherwise close cleanly.
        if (!next && !isProvisioning) onClose()
      }}
    >
      <DialogContent showCloseButton={!isProvisioning} className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isError ? 'Demo generation failed' : 'Generating demo workspace'}
          </DialogTitle>
          <DialogDescription>
            {isError
              ? 'Nothing was left behind — the partial demo was rolled back. You can try again.'
              : 'Seeding a fully-populated workspace with synthetic data. This takes a few seconds.'}
          </DialogDescription>
        </DialogHeader>

        {/* Single polite live region so screen readers hear progress + result. */}
        <p className="sr-only" aria-live="polite" role="status">
          {announcement}
        </p>

        {isError ? (
          <div
            role="alert"
            className="rounded-lg border px-3 py-2.5 text-[12.5px] leading-[1.45]"
            style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--fg)' }}
          >
            {getErrorMessage(error)}
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
            <Button type="button" variant="outline" disabled>
              Generating…
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
