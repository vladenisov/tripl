import { useEffect, useId, useRef, useState, type ChangeEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { anomalySettingsApi } from "@/api/anomalySettings"
import type { ProjectAnomalySettings } from "@/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ErrorState } from "@/components/error-state"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ReadOnlyNotice } from "@/components/read-only-notice"
import { useConfirm } from "@/hooks/useConfirm"
import { SILENT_ERROR_META } from "@/lib/errorFeedback"
import { useCanWriteProject } from "@/lib/permissions"
import { getErrorMessage } from '@/lib/utils'
import { anomalyScopeOverridesKey, projectAnomalySettingsKey } from '@/lib/queryKeys'

// How long the "Saved" hint stays up after an autosave lands.
const SAVED_HINT_MS = 2000

/**
 * A numeric detection setting that saves when you finish, not as you type.
 *
 * These inputs used to fire the mutation from `onChange`, so typing "168" into
 * Baseline window persisted 1, then 16, then 168 — and each intermediate value
 * was a live detection setting that a collection running in that window would
 * read. The field is also briefly empty whenever someone selects-all and
 * retypes, and `Number('')` is `0`, which is *valid* for `min_expected_count`
 * and `anomaly_ingestion_settling_minutes` (settling 0 = score immediately, the
 * very behaviour the allowance exists to prevent). Committing on blur/Enter
 * removes the whole class (tripl-jfm3.105).
 *
 * Local state is seeded from the server value and re-seeded whenever it changes,
 * so an edit made elsewhere still lands here; empty and non-numeric input is
 * dropped and the field snaps back to the last saved value.
 *
 * Three more things an autosave owes the person typing (PLAN-55). A value
 * outside `min`/`max` is refused here with the bound named, instead of being
 * sent to earn a 422. A rejected save puts the saved value back: the server
 * value never changed, so the re-seed above never ran and the input kept the
 * refused number beside the error — and a reload then brought the old one back.
 * And a save that lands says so, briefly, because a commit on blur is otherwise
 * invisible.
 */
function NumberSetting({
  id,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  id: string
  value: number
  min?: number
  max?: number
  step?: string
  onCommit: (value: number) => Promise<unknown>
}) {
  // Re-seed from the server value when it changes, without an effect: this is
  // React's documented "adjust state while rendering" pattern, and it lands the
  // new value in the same pass rather than flashing the stale one first.
  const [draft, setDraft] = useState(String(value))
  const [seeded, setSeeded] = useState(value)
  if (seeded !== value) {
    setSeeded(value)
    setDraft(String(value))
  }
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const savedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(savedTimer.current), [])
  const hintId = useId()

  const commit = () => {
    const raw = draft.trim()
    const parsed = Number(raw)
    if (raw === '' || !Number.isFinite(parsed)) {
      setDraft(String(value))
      setRangeError(null)
      return
    }
    if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      setRangeError(
        min !== undefined && max !== undefined
          ? `Must be between ${min} and ${max}.`
          : min !== undefined
            ? `Must be at least ${min}.`
            : `Must be at most ${max}.`,
      )
      setDraft(String(value))
      return
    }
    setRangeError(null)
    if (parsed === value) return
    setStatus('saving')
    onCommit(parsed).then(
      () => {
        setStatus('saved')
        window.clearTimeout(savedTimer.current)
        savedTimer.current = window.setTimeout(() => setStatus('idle'), SAVED_HINT_MS)
      },
      () => {
        // The refusal itself is rendered once, under the card.
        setStatus('idle')
        setDraft(String(value))
      },
    )
  }

  return (
    <div className="grid gap-1">
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-invalid={rangeError ? true : undefined}
        aria-describedby={rangeError ? hintId : undefined}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setDraft(e.target.value)
          setRangeError(null)
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      {rangeError ? (
        <p id={hintId} role="alert" className="text-xs text-destructive">{rangeError}</p>
      ) : (
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </p>
      )}
    </div>
  )
}

const SCOPE_TYPE_LABELS: Record<string, string> = {
  project_total: 'Project total',
  event_type: 'Event type',
  event: 'Event',
  metric: 'Metric',
}

/**
 * The undo surface for the false-positive ratchet.
 *
 * Marking an alert a false positive permanently tightens the scope it fired on
 * — it never decays and there is no confirmation step — so the only way back is
 * to see the override here and remove it. Deleting drops that scope straight
 * back to the project settings above; every other scope is untouched.
 */
function ScopeOverridesCard({ slug, canWrite }: { slug: string; canWrite: boolean }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: anomalyScopeOverridesKey(slug),
    queryFn: () => anomalySettingsApi.listScopeOverrides(slug),
    // Rendered as an ErrorState in the card.
    meta: SILENT_ERROR_META,
  })

  const removeMut = useMutation({
    // Its error is rendered under the list.
    meta: SILENT_ERROR_META,
    mutationFn: (overrideId: string) => anomalySettingsApi.deleteScopeOverride(slug, overrideId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: anomalyScopeOverridesKey(slug) })
    },
  })

  const overrides = data?.items ?? []

  // Removing an override is not undoable from here either: the scope drops
  // straight back to the project settings, and only more false-positive marks
  // would tighten it again. One click used to do it (PLAN-55).
  const handleRemove = async (overrideId: string, scopeName: string) => {
    const ok = await confirm({
      title: 'Remove scope override',
      message: `Remove the override for "${scopeName}"? The scope goes back to the project settings above, and its false-positive count is lost.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (ok) removeMut.mutate(overrideId)
  }

  return (
    <Card>
      {dialog}
      <CardContent className="p-6 space-y-4">
        <div>
          <Label className="text-sm font-medium">Scope overrides</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Marking an alert a <strong>false positive</strong> makes the detector stricter on that
            scope alone — permanently. These overrides replace the sigma threshold and min expected
            count above for the scopes listed. Removing one puts that scope back on the project
            settings.
          </p>
        </div>

        {/* A failed load is NOT an empty list. `data` is undefined either way, so
            reading the length alone told an operator "no scope has been
            tightened" — a claim about the ratchet — when the request never
            answered (tripl-l429.24). ErrorState is what this app shows for a
            load that failed, and it carries the retry this card needs: it is the
            only undo the permanent ratchet has. */}
        {isPending ? (
          <p className="text-sm text-muted-foreground">Loading scope overrides…</p>
        ) : isError && data === undefined ? (
          <ErrorState
            compact
            title="Couldn't load scope overrides"
            error={error}
            onRetry={() => {
              void refetch()
            }}
            retryLabel="Retry"
          />
        ) : overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No scope has been tightened. Every scope uses the project settings above.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {overrides.map(override => (
              <li
                key={override.id}
                className="flex items-center justify-between gap-4 p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium truncate">{override.scope_name || override.scope_ref}</p>
                  <p className="text-xs text-muted-foreground">
                    {SCOPE_TYPE_LABELS[override.scope_type] ?? override.scope_type}
                    {override.scan_config_name ? ` · ${override.scan_config_name}` : ''} · sigma{' '}
                    {override.sigma_threshold} · min expected {override.min_expected_count} ·{' '}
                    {override.false_positive_count} false positive
                    {override.false_positive_count === 1 ? '' : 's'}
                  </p>
                </div>
                {canWrite && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removeMut.isPending}
                    onClick={() => { void handleRemove(override.id, override.scope_name || override.scope_ref) }}
                    aria-label={`Remove override for ${override.scope_name || override.scope_ref}`}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {removeMut.isError && (
          <p className="text-sm text-destructive">{getErrorMessage(removeMut.error)}</p>
        )}
      </CardContent>
    </Card>
  )
}

export function MonitoringTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteProject()
  const settingsQuery = useQuery({
    queryKey: projectAnomalySettingsKey(slug),
    queryFn: () => anomalySettingsApi.get(slug),
    // Rendered as an ErrorState below, with a retry.
    meta: SILENT_ERROR_META,
  })
  const settings = settingsQuery.data

  const updateMut = useMutation({
    // Its error is rendered under the card.
    meta: SILENT_ERROR_META,
    mutationFn: (data: Partial<ProjectAnomalySettings>) => anomalySettingsApi.update(slug, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectAnomalySettingsKey(slug) })
    },
  })

  const baselineWindowId = useId()
  const minHistoryId = useId()
  const sigmaThresholdId = useId()
  const minExpectedCountId = useId()
  const recentSignalWindowId = useId()
  const settlingMinutesId = useId()

  // A NumberSetting reads the promise to reset its draft on a refusal and to say
  // "Saved" on success; the error itself is rendered once, under the card, so
  // the rejection is handled there rather than left unhandled here.
  const commit = (data: Partial<ProjectAnomalySettings>) => updateMut.mutateAsync(data)

  if (settingsQuery.isError && !settings) {
    // A failed load used to read "Loading detection settings…" forever (PLAN-41).
    return (
      <ErrorState
        title="Couldn't load detection settings"
        error={settingsQuery.error}
        onRetry={() => { void settingsQuery.refetch() }}
        retryLabel="Retry"
      />
    )
  }

  if (!settings) {
    return <div role="status" className="text-sm text-muted-foreground">Loading detection settings…</div>
  }

  // The settling allowance and the open signal window constrain each other: a
  // bucket held back past the window is already stale when it is finally scored,
  // so every signal on the project would read as closed on the Anomalies page
  // while alerts kept firing. The backend refuses that pair from both directions
  // (see settling_window_conflict); these bounds are the hint that keeps an
  // operator from walking into the 422 (tripl-l429.15).
  const settlingCeilingMinutes = Math.max(
    0,
    Math.min(1440, settings.recent_signal_window_hours * 60 - 1),
  )
  const windowFloorHours = Math.max(
    1,
    Math.floor(settings.anomaly_ingestion_settling_minutes / 60) + 1,
  )

  return (
    <div className="space-y-4">
      {/* "Detection settings" — the same words as the buttons on the Anomalies
          and Monitors pages that lead here. The surface used to call itself
          "Monitoring" while its only card called itself "Anomaly Detection",
          giving one thing three names (tripl-jfm3.39). Detection raises
          SIGNALS; monitors are the alert rules layered on top. */}
      <div>
        <h2 className="text-lg font-semibold">Detection settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          How tripl detects signals — spikes and drops in volume — across every scan in this
          project. Scans use these settings automatically when they have both a time column and a
          collection interval.
        </p>
      </div>

      {!canWrite && <ReadOnlyNotice />}
      {settingsQuery.isError && (
        // A failed refresh after an autosave keeps the settings on screen
        // rather than replacing the whole tab (review 204).
        <p role="alert" className="text-xs text-destructive">
          Couldn't refresh detection settings: {getErrorMessage(settingsQuery.error)}
        </p>
      )}

      {/* `disabled` on a fieldset reaches every control inside it, the Switch
          and Checkbox buttons included; `contents` keeps it out of the layout. */}
      <fieldset disabled={!canWrite} className="contents">
        <Card>
          <CardContent className="p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label className="text-sm font-medium">Detection</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Scans inherit these settings. Turning detection off stops new signals being
                  raised; monitors and alert routing are configured under Alerting.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-medium text-muted-foreground min-w-16 text-right">
                  {settings.anomaly_detection_enabled ? 'Enabled' : 'Disabled'}
                </span>
                <Switch
                  checked={settings.anomaly_detection_enabled}
                  onCheckedChange={checked => updateMut.mutate({ anomaly_detection_enabled: checked })}
                  aria-label="Toggle signal detection"
                />
              </div>
            </div>

            {/* Four scopes, not three: catalog metrics have always been detected
                (detect_metrics defaults to on) but had no control here, so the
                only way to stop scoring them was to disable detection entirely
                (tripl-jfm3.108).

                The heading and the sentence under it are the whole reason this is
                a fieldset: four bare checked boxes in a row decide WHAT GETS
                SCORED AT ALL — the most consequential control on the page — and
                nothing on screen said so. The rationale existed only in this
                comment, which no operator reads. `min-w-0` undoes the UA default
                `min-inline-size: min-content` on fieldset, which Tailwind's
                preflight does not reset and which would stop the four-column grid
                inside from ever shrinking. */}
            <fieldset className="min-w-0">
              <legend className="text-sm font-medium">Score these scopes</legend>
              <p className="text-xs text-muted-foreground mt-1 mb-3">
                Detection scores only the scopes checked here. Unchecking one stops new signals
                being raised for it; signals already raised stay on the Anomalies page.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={settings.detect_project_total}
                    onCheckedChange={checked => updateMut.mutate({ detect_project_total: !!checked })}
                  />
                  Project total
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={settings.detect_event_types}
                    onCheckedChange={checked => updateMut.mutate({ detect_event_types: !!checked })}
                  />
                  Event types
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={settings.detect_events}
                    onCheckedChange={checked => updateMut.mutate({ detect_events: !!checked })}
                  />
                  Events
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={settings.detect_metrics}
                    onCheckedChange={checked => updateMut.mutate({ detect_metrics: !!checked })}
                  />
                  Metrics
                </label>
              </div>
            </fieldset>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Two rules hold for all six fields below.
                  (1) Sentence case, like every other label in this app: four of
                      the six were Title Case and two were not, which made one card
                      read as two forms glued together (tripl-jj0h).
                  (2) `content-start` on every cell. Without it a cell inherits the
                      grid default (align-content: stretch), is stretched to its
                      taller sibling, and pads the gaps between its own label,
                      input and help text — which put two side-by-side inputs in
                      the bottom row 11px out of line (labels 5px) purely because
                      one help paragraph ran longer than the other.

                  Both fields in this first row are counted in BUCKETS, and said so
                  nowhere: bare "14" and "7" sat directly above two fields that name
                  their unit and carry a paragraph each, so the page's own pattern
                  pushed the reader toward days. On an hourly scan that reads 14 as
                  fourteen days when it means fourteen hours — an order of
                  magnitude, set by someone trying to quieten a noisy detector
                  (tripl-wb58). */}
              <div className="grid content-start gap-2">
                <Label htmlFor={baselineWindowId}>Baseline window (buckets)</Label>
                <NumberSetting
                  id={baselineWindowId}
                  min={1}
                  value={settings.baseline_window_buckets}
                  onCommit={v => commit({ baseline_window_buckets: v })}
                />
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor={minHistoryId}>Min history (buckets)</Label>
                <NumberSetting
                  id={minHistoryId}
                  min={1}
                  value={settings.min_history_buckets}
                  onCommit={v => commit({ min_history_buckets: v })}
                />
              </div>
              {/* One line for the pair. Deliberately says "the series being
                  scored" and not "the scan": these settings also govern catalog
                  metrics, and a MetricDefinition carries its own interval
                  independent of any scan config — so a daily metric under an
                  hourly scan makes 14 buckets fourteen DAYS. */}
              <p className="text-xs text-muted-foreground md:col-span-2">
                A bucket is one collection interval of the series being scored. On an hourly
                scan, {settings.baseline_window_buckets} buckets of baseline is{' '}
                {settings.baseline_window_buckets} hours; on a daily catalog metric it is{' '}
                {settings.baseline_window_buckets} days.
              </p>
              {/* These two were the only fields on the page with no explanation at
                  all, and they are the two that decide whether anything is flagged
                  — the sigma threshold is both the most consequential and the most
                  opaque control here (tripl-pdyc). Both describe what the detector
                  actually does: `_rolling_anomaly_at` skips a bucket whose baseline
                  expects fewer than min_expected_count, then flags it only when
                  |z| reaches the sigma threshold. */}
              <div className="grid content-start gap-2">
                <Label htmlFor={sigmaThresholdId}>Sigma threshold</Label>
                <NumberSetting
                  id={sigmaThresholdId}
                  min={0.1}
                  step="0.1"
                  value={settings.sigma_threshold}
                  onCommit={v => commit({ sigma_threshold: v })}
                />
                <p className="text-xs text-muted-foreground">
                  How far a bucket has to sit from its baseline before it is flagged, counted in
                  standard deviations of that baseline. Raise it for a quieter detector; lower it
                  to catch smaller moves, at the cost of more signals.
                </p>
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor={minExpectedCountId}>Min expected count</Label>
                <NumberSetting
                  id={minExpectedCountId}
                  min={0}
                  value={settings.min_expected_count}
                  onCommit={v => commit({ min_expected_count: v })}
                />
                <p className="text-xs text-muted-foreground">
                  A floor on the baseline, not on the bucket: any bucket whose baseline expects
                  fewer than {settings.min_expected_count} is skipped, so a quiet series cannot
                  raise a spike off a handful of events. 0 scores every bucket.
                </p>
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor={recentSignalWindowId}>Open signal window (hours)</Label>
                <NumberSetting
                  id={recentSignalWindowId}
                  min={windowFloorHours}
                  max={720}
                  value={settings.recent_signal_window_hours}
                  onCommit={v => commit({ recent_signal_window_hours: v })}
                />
                <p className="text-xs text-muted-foreground">
                  How long an anomaly keeps counting as an open signal on the Anomalies page
                  and in the sidebar badge. Between {windowFloorHours} and 720 hours (30 days).
                  Alert delivery is unaffected. The floor is the settling allowance beside it
                  ({settings.anomaly_ingestion_settling_minutes} min): a window that does not
                  outlast the allowance would close every signal before it could be scored.
                </p>
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor={settlingMinutesId}>Ingestion settling (minutes)</Label>
                <NumberSetting
                  id={settlingMinutesId}
                  min={0}
                  max={settlingCeilingMinutes}
                  value={settings.anomaly_ingestion_settling_minutes}
                  onCommit={v => commit({ anomaly_ingestion_settling_minutes: v })}
                />
                {/* Tightened from seven rendered lines. Every fact the operator
                    needs to set the number is kept — both bounds and why they
                    exist — because these are what stand between them and the
                    backend's 422; what went is the second telling of it. */}
                <p className="text-xs text-muted-foreground">
                  How long a warehouse keeps delivering rows for a bucket after that bucket
                  closes. Those buckets are still collected and charted but raise no signal
                  until the allowance passes, so a half-delivered bucket is not read as a
                  drop — and the allowance is the detection latency you pay for that. Between
                  0 (score immediately) and {settlingCeilingMinutes} minutes: the ceiling is
                  one minute under the open signal window beside it{' '}
                  ({settings.recent_signal_window_hours}h), and never above 1440 (24 hours).
                </p>
              </div>
            </div>

            <div className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
              Markers appear only when the latest bucket for a scope is anomalous.
              After changing these settings, run the next metrics collection to recalculate signals.
            </div>

            {updateMut.isError && (
              <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>
            )}
          </CardContent>
        </Card>
      </fieldset>

      <ScopeOverridesCard slug={slug} canWrite={canWrite} />
    </div>
  )
}
