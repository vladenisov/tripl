import { useId, useState, type ChangeEvent } from "react"
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
import { getErrorMessage } from '@/lib/utils'

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
  onCommit: (value: number) => void
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

  const commit = () => {
    const raw = draft.trim()
    const parsed = Number(raw)
    if (raw === '' || !Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
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
function ScopeOverridesCard({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['anomalyScopeOverrides', slug],
    queryFn: () => anomalySettingsApi.listScopeOverrides(slug),
  })

  const removeMut = useMutation({
    mutationFn: (overrideId: string) => anomalySettingsApi.deleteScopeOverride(slug, overrideId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['anomalyScopeOverrides', slug] })
    },
  })

  const overrides = data?.items ?? []

  return (
    <Card>
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
        ) : isError ? (
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={removeMut.isPending}
                  onClick={() => removeMut.mutate(override.id)}
                  aria-label={`Remove override for ${override.scope_name || override.scope_ref}`}
                >
                  Remove
                </Button>
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
  const { data: settings } = useQuery({
    queryKey: ['projectAnomalySettings', slug],
    queryFn: () => anomalySettingsApi.get(slug),
  })

  const updateMut = useMutation({
    mutationFn: (data: Partial<ProjectAnomalySettings>) => anomalySettingsApi.update(slug, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projectAnomalySettings', slug] })
    },
  })

  const baselineWindowId = useId()
  const minHistoryId = useId()
  const sigmaThresholdId = useId()
  const minExpectedCountId = useId()
  const recentSignalWindowId = useId()
  const settlingMinutesId = useId()

  if (!settings) {
    return <div className="text-sm text-muted-foreground">Loading detection settings…</div>
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
                onCommit={v => updateMut.mutate({ baseline_window_buckets: v })}
              />
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor={minHistoryId}>Min history (buckets)</Label>
              <NumberSetting
                id={minHistoryId}
                min={1}
                value={settings.min_history_buckets}
                onCommit={v => updateMut.mutate({ min_history_buckets: v })}
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
                onCommit={v => updateMut.mutate({ sigma_threshold: v })}
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
                onCommit={v => updateMut.mutate({ min_expected_count: v })}
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
                onCommit={v => updateMut.mutate({ recent_signal_window_hours: v })}
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
                onCommit={v => updateMut.mutate({ anomaly_ingestion_settling_minutes: v })}
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

      <ScopeOverridesCard slug={slug} />
    </div>
  )
}
