import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { scansApi } from '@/api/scans'
import type {
  EventGroupRule,
  IntervalCode,
  ScanConfig,
  ScanConfigPreview,
  ScanDryRunRequest,
  ScanDryRunResponse,
} from '@/types'
import { type UiEventGroupRule, stripUiIds, withUiIds } from './scanFormTypes'
import { type ScanFormMode, formModeOf } from './scanMode'
import { eligibleChunkIntervals, parseOptionalPositiveInt, parseOptionalShare } from './scanUtils'

// Shape of the create/update payload shared by both API calls. Built once from
// form state so the create page and the Configuration tab stay in sync.
export interface ScanFormPayload {
  name: string
  base_query: string
  event_type_id: string | null
  event_type_column: string | null
  time_column: string | null
  event_name_format: string | null
  json_value_paths: string[]
  event_group_rules: EventGroupRule[]
  metric_breakdown_columns: string[]
  metric_breakdown_values_limit: number | null
  distribution_drift_fields: string[]
  app_version_column: string | null
  app_version_prerelease_pattern: string | null
  app_version_active_share_min: number | null
  platform_column: string | null
  cardinality_threshold: number
  interval: string | null
  replay_chunk_interval: string | null
  scan_lookback_hours: number | null
  scan_row_limit: number | null
  metrics_row_limit: number | null
}

export interface ScanFormState {
  /**
   * Form state only — never sent to the backend, never stored. It decides which
   * fields the form asks for and whether the payload carries a schedule (see
   * scanMode.ts). It does NOT decide the time column: that is a query bound in
   * both modes and is the user's to set or clear.
   */
  mode: ScanFormMode
  dataSourceId: string
  name: string
  baseQuery: string
  eventTypeId: string
  eventTypeColumn: string
  timeColumn: string
  appVersionColumn: string
  appVersionPrereleasePattern: string
  appVersionActiveShareMin: string
  platformColumn: string
  eventNameFormat: string
  jsonValuePaths: string[]
  eventGroupRules: UiEventGroupRule[]
  metricBreakdownColumns: string[]
  metricBreakdownValuesLimit: string
  distributionDriftFields: string[]
  cardinalityThreshold: number
  interval: string
  chunkInterval: string
  scanLookbackHours: string
  scanRowLimit: string
  metricsRowLimit: string
}

function initialState(scanConfig: ScanConfig | null): ScanFormState {
  return {
    mode: formModeOf(scanConfig),
    dataSourceId: scanConfig?.data_source_id ?? '',
    name: scanConfig?.name ?? '',
    baseQuery: scanConfig?.base_query ?? '',
    eventTypeId: scanConfig?.event_type_id ?? '',
    eventTypeColumn: scanConfig?.event_type_column ?? '',
    timeColumn: scanConfig?.time_column ?? '',
    appVersionColumn: scanConfig?.app_version_column ?? '',
    appVersionPrereleasePattern: scanConfig?.app_version_prerelease_pattern ?? '',
    appVersionActiveShareMin: scanConfig?.app_version_active_share_min != null
      ? String(scanConfig.app_version_active_share_min)
      : '',
    platformColumn: scanConfig?.platform_column ?? '',
    eventNameFormat: scanConfig?.event_name_format ?? '',
    jsonValuePaths: scanConfig?.json_value_paths ?? [],
    eventGroupRules: withUiIds(scanConfig?.event_group_rules ?? []),
    metricBreakdownColumns: scanConfig?.metric_breakdown_columns ?? [],
    metricBreakdownValuesLimit: scanConfig?.metric_breakdown_values_limit
      ? String(scanConfig.metric_breakdown_values_limit)
      : '',
    distributionDriftFields: scanConfig?.distribution_drift_fields ?? [],
    cardinalityThreshold: scanConfig?.cardinality_threshold ?? 100,
    interval: scanConfig?.interval ?? '',
    chunkInterval: scanConfig?.replay_chunk_interval ?? '',
    // New scans default to a 24h lookback (matches the create-page mockup); when
    // editing an existing config an explicit null stays empty (backend default).
    scanLookbackHours: scanConfig
      ? (scanConfig.scan_lookback_hours == null ? '' : String(scanConfig.scan_lookback_hours))
      : '24',
    scanRowLimit: scanConfig?.scan_row_limit == null ? '' : String(scanConfig.scan_row_limit),
    metricsRowLimit: scanConfig?.metrics_row_limit == null ? '' : String(scanConfig.metrics_row_limit),
  }
}

/**
 * Assembles the create/update payload from form state.
 *
 * Catalog only is the absence of a SCHEDULE, and nothing else. The dispatcher
 * selects on `time_column IS NOT NULL AND interval IS NOT NULL`
 * (worker/tasks/metrics/schedule.py:349-350), so a null interval alone already
 * makes a config catalog-only; nulling the time column with it bought nothing
 * and cost the per-run bound, because `resolve_lookback_window` returns None
 * without a time column and the run then reads the whole base query. That is why
 * only `interval` and `replay_chunk_interval` are mode-gated here: a saved time
 * column must survive an edit made in Catalog only, and a catalog scan bounded
 * to the last 24h is a config a user is entitled to keep.
 *
 * Monitoring additionally REQUIRES the time column — `canSubmitScanForm` refuses
 * to submit without it, so the silently-never-monitoring config this whole change
 * exists to kill cannot be created.
 */
export function toBackendPayload(state: ScanFormState): ScanFormPayload {
  const monitoring = state.mode === 'monitoring'
  return {
    name: state.name,
    base_query: state.baseQuery,
    event_type_id: state.eventTypeId || null,
    event_type_column: state.eventTypeColumn || null,
    time_column: state.timeColumn || null,
    event_name_format: state.eventNameFormat || null,
    json_value_paths: state.jsonValuePaths,
    event_group_rules: stripUiIds(state.eventGroupRules),
    metric_breakdown_columns: state.metricBreakdownColumns,
    metric_breakdown_values_limit: state.metricBreakdownValuesLimit
      ? Number(state.metricBreakdownValuesLimit)
      : null,
    distribution_drift_fields: state.distributionDriftFields,
    app_version_column: state.appVersionColumn || null,
    app_version_prerelease_pattern: state.appVersionColumn
      ? state.appVersionPrereleasePattern.trim() || null
      : null,
    app_version_active_share_min: state.appVersionColumn
      ? parseOptionalShare(state.appVersionActiveShareMin)
      : null,
    platform_column: state.platformColumn || null,
    cardinality_threshold: state.cardinalityThreshold,
    interval: monitoring ? state.interval || null : null,
    replay_chunk_interval: monitoring ? state.chunkInterval || null : null,
    scan_lookback_hours: parseOptionalPositiveInt(state.scanLookbackHours),
    scan_row_limit: parseOptionalPositiveInt(state.scanRowLimit),
    metrics_row_limit: parseOptionalPositiveInt(state.metricsRowLimit),
  }
}

/**
 * The draft a dry run is computed from, derived from the SAME payload the save
 * button would send.
 *
 * Building it out of `toBackendPayload` is the point: "what would this scan
 * create?" has to be answered for the config that would actually be saved, not
 * for a second reading of form state that could drift from it. The window the
 * dry run reads is therefore the window the saved scan would read — including
 * the case with no time column, where both read everything the base query
 * returns and the panel says so.
 */
export function toDryRunRequest(state: ScanFormState): ScanDryRunRequest {
  const payload = toBackendPayload(state)
  return {
    data_source_id: state.dataSourceId,
    base_query: payload.base_query,
    event_type_id: payload.event_type_id,
    event_type_column: payload.event_type_column,
    time_column: payload.time_column,
    event_name_format: payload.event_name_format,
    event_group_rules: payload.event_group_rules,
    json_value_paths: payload.json_value_paths,
    cardinality_threshold: payload.cardinality_threshold,
    app_version_column: payload.app_version_column,
    platform_column: payload.platform_column,
    scan_lookback_hours: payload.scan_lookback_hours,
  }
}

/** Hover text on the disabled save/create button in Catalog + monitoring. */
export const MONITORING_INCOMPLETE_TITLE =
  'Catalog + monitoring needs a time column and a schedule.'

/**
 * Save gate shared by create and edit. In Catalog only, empty is a deliberate
 * answer; in Catalog + monitoring both columns are required, because a config
 * missing either one is never dispatched and collects nothing, forever.
 */
export function canSubmitScanForm(state: ScanFormState): boolean {
  if (!state.dataSourceId || !state.name.trim() || !state.baseQuery.trim()) return false
  if (state.mode === 'catalog') return true
  return Boolean(state.timeColumn && state.interval)
}

export interface UseScanFormResult {
  state: ScanFormState
  set: <K extends keyof ScanFormState>(key: K, value: ScanFormState[K]) => void
  preview: ScanConfigPreview | null
  setPreview: (preview: ScanConfigPreview | null) => void
  /** "What this scan would create", or null before the first check. */
  dryRun: ScanDryRunResponse | null
  /**
   * True when the form has changed since the displayed answer was computed. A
   * dry run is a statement about a specific draft; once the draft moves, the
   * answer is stale, and a stale "would create 3 events: A, B, C" is worse than
   * no answer at all.
   */
  dryRunStale: boolean
  // Preview/discovery mutations (real warehouse-backed jobs).
  previewMut: ReturnType<typeof useMutation<ScanConfigPreview, unknown, void>>
  discoverJsonMut: ReturnType<typeof useMutation<ScanConfigPreview, unknown, void>>
  dryRunMut: ReturnType<typeof useMutation<ScanDryRunResponse, unknown, ScanDryRunRequest>>
  /** Load the sample rows and the dry run together — one button, one answer. */
  loadPreview: () => void
  /** Re-answer "what would this scan create?" for the draft as it stands now. */
  runDryRun: () => void
  // Field-aware handlers that drop now-invalid column references.
  setBaseQuery: (value: string) => void
  setDataSourceId: (value: string) => void
  setEventTypeColumn: (value: string) => void
  setTimeColumn: (value: string) => void
  setAppVersionColumn: (value: string) => void
  setPlatformColumn: (value: string) => void
  setInterval: (value: string) => void
  toggleJsonValuePath: (path: string) => void
  toggleMetricBreakdownColumn: (column: string) => void
  toggleDistributionDriftField: (field: string) => void
  toBackendPayload: () => ScanFormPayload
}

// Centralizes the create/edit form behavior (state, preview gating, column
// invalidation, payload assembly) so the create page and Configuration tab share
// one implementation. `dataSourceIdForPreview` lets the edit flow lock the source.
export function useScanForm(
  slug: string,
  scanConfig: ScanConfig | null,
): UseScanFormResult {
  const [state, setState] = useState<ScanFormState>(() => initialState(scanConfig))
  const [preview, setPreview] = useState<ScanConfigPreview | null>(null)
  // The answer AND the draft it answers for, so staleness is a fact rather than
  // a guess. Serializing the request is enough: it is exactly the set of inputs
  // the backend planner reads.
  const [dryRunResult, setDryRunResult] = useState<
    { answer: ScanDryRunResponse; requestKey: string } | null
  >(null)

  const set = <K extends keyof ScanFormState>(key: K, value: ScanFormState[K]) =>
    setState(current => ({ ...current, [key]: value }))

  const setMany = (patch: Partial<ScanFormState>) =>
    setState(current => ({ ...current, ...patch }))

  const previewMut = useMutation<ScanConfigPreview, unknown, void>({
    mutationFn: () =>
      scansApi.preview(slug, {
        data_source_id: state.dataSourceId,
        base_query: state.baseQuery,
        limit: 10,
        time_column: state.timeColumn || null,
        scan_lookback_hours: parseOptionalPositiveInt(state.scanLookbackHours),
      }),
    onSuccess: data => {
      setPreview(data)
      const has = (name: string) => data.columns.some(column => column.name === name)
      setState(current => {
        const eventTypeColumn = has(current.eventTypeColumn) ? current.eventTypeColumn : ''
        const timeColumn = has(current.timeColumn) ? current.timeColumn : ''
        const appVersionColumn = has(current.appVersionColumn) ? current.appVersionColumn : ''
        const platformColumn = has(current.platformColumn) ? current.platformColumn : ''
        const reserved = new Set(
          [eventTypeColumn, timeColumn, appVersionColumn, platformColumn].filter(Boolean),
        )
        return {
          ...current,
          eventTypeColumn,
          timeColumn,
          appVersionColumn,
          platformColumn,
          appVersionPrereleasePattern: appVersionColumn ? current.appVersionPrereleasePattern : '',
          appVersionActiveShareMin: appVersionColumn ? current.appVersionActiveShareMin : '',
          metricBreakdownColumns: current.metricBreakdownColumns.filter(
            column => has(column) && !reserved.has(column),
          ),
          distributionDriftFields: current.distributionDriftFields.filter(
            field => has(field) && !reserved.has(field),
          ),
        }
      })
    },
  })

  // Keyed off the mutation's own variables, not off a closure: React Query keeps
  // the LATEST options object, so an onSuccess that read the current render's
  // request would stamp an in-flight answer with a draft it was not computed
  // from — and silently call a stale answer fresh.
  const dryRunMut = useMutation<ScanDryRunResponse, unknown, ScanDryRunRequest>({
    mutationFn: request => scansApi.dryRun(slug, request),
    onSuccess: (answer, request) =>
      setDryRunResult({ answer, requestKey: JSON.stringify(request) }),
  })

  const runDryRun = () => dryRunMut.mutate(toDryRunRequest(state))

  const discoverJsonMut = useMutation<ScanConfigPreview, unknown, void>({
    mutationFn: () =>
      scansApi.preview(slug, {
        data_source_id: state.dataSourceId,
        base_query: state.baseQuery,
        json_value_paths: state.jsonValuePaths,
        time_column: state.timeColumn || null,
        scan_lookback_hours: parseOptionalPositiveInt(state.scanLookbackHours),
        include_json_paths: true,
      }),
    onSuccess: data => {
      // Merge into the loaded preview; discard if the preview was reset mid-flight.
      setPreview(current => (current ? { ...current, json_columns: data.json_columns } : current))
    },
  })

  const resetPreviewDerived = () => {
    setPreview(null)
    setMany({ distributionDriftFields: [] })
    discoverJsonMut.reset()
    // A new source or a new query invalidates the answer outright — not merely
    // stales it. Keeping it on screen would attribute events to a query that no
    // longer exists.
    setDryRunResult(null)
    dryRunMut.reset()
  }

  /**
   * One button, both warehouse jobs. The sample rows populate the column pickers
   * and the dry run says what the config would create; splitting them into two
   * controls would make "what would this create?" an optional extra, which is
   * how the promise in the docs went unbuilt in the first place.
   */
  const loadPreview = () => {
    discoverJsonMut.reset()
    previewMut.mutate()
    runDryRun()
  }

  const setBaseQuery = (value: string) => {
    setMany({ baseQuery: value, jsonValuePaths: [] })
    resetPreviewDerived()
  }

  const setDataSourceId = (value: string) => {
    setMany({ dataSourceId: value, jsonValuePaths: [] })
    resetPreviewDerived()
  }

  const setEventTypeColumn = (value: string) =>
    setState(current => ({
      ...current,
      eventTypeColumn: value,
      metricBreakdownColumns: current.metricBreakdownColumns.filter(column => column !== value),
      distributionDriftFields: current.distributionDriftFields.filter(field => field !== value),
    }))

  const setTimeColumn = (value: string) =>
    setState(current => ({
      ...current,
      timeColumn: value,
      metricBreakdownColumns: current.metricBreakdownColumns.filter(column => column !== value),
      distributionDriftFields: current.distributionDriftFields.filter(field => field !== value),
    }))

  const setAppVersionColumn = (value: string) =>
    setState(current => ({
      ...current,
      appVersionColumn: value,
      appVersionPrereleasePattern: value ? current.appVersionPrereleasePattern : '',
      appVersionActiveShareMin: value ? current.appVersionActiveShareMin : '',
      metricBreakdownColumns: current.metricBreakdownColumns.filter(column => column !== value),
      distributionDriftFields: current.distributionDriftFields.filter(field => field !== value),
    }))

  const setPlatformColumn = (value: string) =>
    setState(current => ({
      ...current,
      platformColumn: value,
      metricBreakdownColumns: current.metricBreakdownColumns.filter(column => column !== value),
      distributionDriftFields: current.distributionDriftFields.filter(field => field !== value),
    }))

  const setInterval = (value: string) =>
    setState(current => ({
      ...current,
      interval: value,
      chunkInterval:
        current.chunkInterval
        && !eligibleChunkIntervals(value).includes(current.chunkInterval as IntervalCode)
          ? ''
          : current.chunkInterval,
    }))

  const toggleJsonValuePath = (path: string) =>
    setState(current => ({
      ...current,
      jsonValuePaths: current.jsonValuePaths.includes(path)
        ? current.jsonValuePaths.filter(item => item !== path)
        : [...current.jsonValuePaths, path],
    }))

  const toggleMetricBreakdownColumn = (column: string) =>
    setState(current => ({
      ...current,
      metricBreakdownColumns: current.metricBreakdownColumns.includes(column)
        ? current.metricBreakdownColumns.filter(item => item !== column)
        : [...current.metricBreakdownColumns, column],
    }))

  const toggleDistributionDriftField = (field: string) =>
    setState(current => ({
      ...current,
      distributionDriftFields: current.distributionDriftFields.includes(field)
        ? current.distributionDriftFields.filter(item => item !== field)
        : [...current.distributionDriftFields, field],
    }))

  return {
    state,
    set,
    preview,
    setPreview,
    dryRun: dryRunResult?.answer ?? null,
    dryRunStale: dryRunResult != null && dryRunResult.requestKey !== JSON.stringify(toDryRunRequest(state)),
    previewMut,
    discoverJsonMut,
    dryRunMut,
    loadPreview,
    runDryRun,
    setBaseQuery,
    setDataSourceId,
    setEventTypeColumn,
    setTimeColumn,
    setAppVersionColumn,
    setPlatformColumn,
    setInterval,
    toggleJsonValuePath,
    toggleMetricBreakdownColumn,
    toggleDistributionDriftField,
    toBackendPayload: () => toBackendPayload(state),
  }
}
