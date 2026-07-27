/**
 * The estimated-progress list shared by demo create and demo reset.
 *
 * Both are single blocking POSTs of ~10 s with no server-side stage feed, so the
 * list narrates *expected* phases on a timer. Passed phases are deliberately NOT
 * ticked while the request is open — the client cannot observe that the server
 * finished them (tripl-jfm3.16) — and the caption says so.
 */

import { Check, Loader2 } from 'lucide-react'
import { PROVISIONING_PHASES } from './provisioningPhases'

type PhaseState = 'done' | 'estimated' | 'active' | 'pending'

export function ProvisioningPhaseList({
  phaseIndex,
  complete = false,
}: {
  phaseIndex: number
  /** True once the request has actually resolved — the only proof work is done. */
  complete?: boolean
}) {
  return (
    <div className="space-y-2">
      <ol className="space-y-1.5">
        {PROVISIONING_PHASES.map((phase, index) => {
          const state: PhaseState = complete
            ? 'done'
            : index < phaseIndex
              ? 'estimated'
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
      {!complete && (
        <p className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
          Estimated steps — the server reports only the final result, not the stage it is on.
        </p>
      )}
    </div>
  )
}

function PhaseIcon({ state }: { state: PhaseState }) {
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
  if (state === 'estimated') {
    return (
      <span
        aria-hidden="true"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--surface-hover)' }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--fg-faint)' }} />
      </span>
    )
  }
  if (state === 'active') {
    return (
      <Loader2
        aria-hidden="true"
        className="h-5 w-5 shrink-0 animate-spin"
        style={{ color: 'var(--accent)' }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
      style={{ borderColor: 'var(--border)' }}
    />
  )
}
