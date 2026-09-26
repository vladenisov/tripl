/**
 * Triage for open signals no alert rule routed to an incident (MO-4 / JR-5).
 *
 * A routed signal (it carries `incident_id`) is triaged in the alert inbox and
 * keeps its "Open incident" link; everything else gets three verdicts here:
 * acknowledge (seen, stays listed), mute the scope (hidden for 24 h, 7 d or
 * until unmuted) and mark as expected (a chart annotation on the bucket, and
 * the signal is hidden). Hidden signals leave every open-signal count.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { eventMetricsApi } from '@/api/eventMetrics'
import { formatTimestamp } from '@/lib/datetime'
import {
  activeSignalsKey,
  projectChartAnnotationsKey,
  projectKey,
  projectsKey,
} from '@/lib/queryKeys'
import type { MonitoringSignal, SignalMuteDuration, SignalTriageScope } from '@/types'

/** The mute lengths the row menu offers, in the order it lists them. */
export const MUTE_OPTIONS: ReadonlyArray<{ duration: SignalMuteDuration; label: string }> = [
  { duration: '24h', label: 'For 24 hours' },
  { duration: '7d', label: 'For 7 days' },
  { duration: 'until_unmuted', label: 'Until unmuted' },
]

/** Scopes a verdict can be recorded on: the ones the signal lists surface. */
const TRIAGE_SCOPES = new Set(['project_total', 'event_type', 'event', 'metric'])

/** Whether this row gets the triage actions: open here, and not an incident. */
export function canTriageSignal(signal: MonitoringSignal): boolean {
  return !signal.incident_id && TRIAGE_SCOPES.has(signal.scope_type)
}

/** The key a verdict is written under, the way the signal keys itself. */
export function triageScopeOf(signal: MonitoringSignal): SignalTriageScope {
  return {
    // A catalog metric is project-global: it carries no scan config.
    scan_config_id: signal.scope_type === 'metric' ? null : signal.scan_config_id,
    scope_type: signal.scope_type,
    scope_ref: signal.scope_ref,
    bucket: signal.bucket,
  }
}

/**
 * The verdict a row shows next to its name, or null when it has none.
 * Expected wins over muted (it answers this one signal), and both over
 * acknowledged, which does not hide anything.
 */
export function triageStatusLabel(signal: MonitoringSignal): string | null {
  if (signal.expected) return 'Expected'
  if (signal.muted) {
    return signal.muted_until ? `Muted until ${formatTimestamp(signal.muted_until)}` : 'Muted'
  }
  if (signal.acknowledged_at) return 'Acknowledged'
  return null
}

/** How many signals in `signals` a verdict hides: the "Show hidden (n)" count. */
export function countHiddenSignals(signals: readonly MonitoringSignal[]): number {
  return signals.filter((signal) => signal.hidden).length
}

export type TriageVerb =
  | { kind: 'acknowledge' }
  | { kind: 'unacknowledge' }
  | { kind: 'mute'; duration: SignalMuteDuration }
  | { kind: 'unmute' }
  | { kind: 'expected'; note: string | null }
  | { kind: 'unexpected' }

function runVerb(slug: string, scope: SignalTriageScope, verb: TriageVerb): Promise<unknown> {
  switch (verb.kind) {
    case 'acknowledge':
      return eventMetricsApi.acknowledgeSignal(slug, scope)
    case 'unacknowledge':
      return eventMetricsApi.unacknowledgeSignal(slug, scope)
    case 'mute':
      return eventMetricsApi.muteSignalScope(slug, scope, verb.duration)
    case 'unmute':
      return eventMetricsApi.unmuteSignalScope(slug, scope)
    case 'expected':
      return eventMetricsApi.markSignalExpected(slug, scope, verb.note)
    case 'unexpected':
      return eventMetricsApi.unmarkSignalExpected(slug, scope)
  }
}

/** The undo of each verdict, offered on its confirmation toast. */
const UNDO: Partial<Record<TriageVerb['kind'], TriageVerb>> = {
  acknowledge: { kind: 'unacknowledge' },
  mute: { kind: 'unmute' },
  expected: { kind: 'unexpected' },
}

const DONE_MESSAGE: Record<TriageVerb['kind'], string> = {
  acknowledge: 'Signal acknowledged',
  unacknowledge: 'Acknowledgement removed',
  mute: 'Scope muted',
  unmute: 'Scope unmuted',
  expected: 'Marked as expected',
  unexpected: 'No longer marked as expected',
}

/**
 * One mutation for every verdict. On success it refreshes every surface that
 * reads the signals — the lists, the sidebar badge (project summaries) and, for
 * "expected", the chart annotations — and confirms with an Undo.
 */
export function useSignalTriage(slug: string) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: ({ scope, verb }: { scope: SignalTriageScope; verb: TriageVerb }) =>
      runVerb(slug, scope, verb),
    onSuccess: (_data, { scope, verb }) => {
      void qc.invalidateQueries({ queryKey: activeSignalsKey(slug) })
      void qc.invalidateQueries({ queryKey: projectKey(slug) })
      void qc.invalidateQueries({ queryKey: projectsKey() })
      if (verb.kind === 'expected' || verb.kind === 'unexpected') {
        void qc.invalidateQueries({ queryKey: projectChartAnnotationsKey(slug) })
      }
      const undo = UNDO[verb.kind]
      toast.success(DONE_MESSAGE[verb.kind], {
        action: undo
          ? { label: 'Undo', onClick: () => mutation.mutate({ scope, verb: undo }) }
          : undefined,
      })
    },
  })
  return {
    isPending: mutation.isPending,
    // A failure is reported by the app-wide mutation error toast.
    run: (signal: MonitoringSignal, verb: TriageVerb, onDone?: () => void) =>
      mutation.mutate({ scope: triageScopeOf(signal), verb }, { onSuccess: onDone }),
  }
}
