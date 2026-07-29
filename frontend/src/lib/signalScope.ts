import type { MonitoringSignal } from '@/types'

export type NameMap = ReadonlyMap<string, string>

const EMPTY_NAMES: NameMap = new Map()

/** How each scope kind is spelled when there is no display name to show. */
const SCOPE_KIND_LABELS: Record<string, string> = {
  event_type: 'Event type',
  event: 'Event',
  metric: 'Metric',
  schema_drift: 'Schema drift',
  distribution_drift: 'Distribution drift',
  variable_value_drift: 'Value drift',
  release_regression: 'Release regression',
}

/**
 * "<Scope> · <name>" for one signal, falling back to "<Scope> <ref8>".
 *
 * One definition, because there were three and one had drifted: the top bar's
 * copy ended in `return \`event ${shortRef}\``, so every scope it did not name
 * explicitly — metric, schema drift, distribution drift, variable-value drift,
 * release regression — was announced to the operator as an *event*
 * (tripl-jfm3.120). Those scopes only became reachable in the bell when it
 * switched to the expanded list (tripl-jfm3.89), which is how a wrong fallback
 * that had always been there started lying out loud.
 *
 * Name maps are optional: a signal carries only its scope id, so the short ref
 * is what renders while the corresponding list loads, when the entity has been
 * deleted, or on a surface that deliberately does not fetch name catalogs.
 */
export function signalScopeLabel(
  signal: MonitoringSignal,
  {
    metricNames = EMPTY_NAMES,
    eventTypeNames = EMPTY_NAMES,
    eventNames = EMPTY_NAMES,
  }: {
    metricNames?: NameMap
    eventTypeNames?: NameMap
    eventNames?: NameMap
  } = {},
): string {
  if (signal.scope_type === 'project_total') return 'Project total'

  const ref = signal.scope_ref.slice(0, 8)
  const kind = SCOPE_KIND_LABELS[signal.scope_type] ?? signal.scope_type
  const names: NameMap | undefined =
    signal.scope_type === 'event_type'
      ? eventTypeNames
      : signal.scope_type === 'event'
        ? eventNames
        : signal.scope_type === 'metric'
          ? metricNames
          : undefined

  const name = names?.get(signal.scope_ref)
  return name ? `${kind} · ${name}` : `${kind} ${ref}`
}
