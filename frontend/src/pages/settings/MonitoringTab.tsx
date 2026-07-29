import { useId, useState, type ChangeEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { anomalySettingsApi } from "@/api/anomalySettings"
import type { ProjectAnomalySettings } from "@/types"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getErrorMessage } from '@/lib/utils'

/**
 * A numeric detection setting that saves when you finish, not as you type.
 *
 * These inputs used to fire the mutation from `onChange`, so typing "168" into
 * Baseline Window persisted 1, then 16, then 168 — and each intermediate value
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor={baselineWindowId}>Baseline Window</Label>
              <NumberSetting
                id={baselineWindowId}
                min={1}
                value={settings.baseline_window_buckets}
                onCommit={v => updateMut.mutate({ baseline_window_buckets: v })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={minHistoryId}>Min History</Label>
              <NumberSetting
                id={minHistoryId}
                min={1}
                value={settings.min_history_buckets}
                onCommit={v => updateMut.mutate({ min_history_buckets: v })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={sigmaThresholdId}>Sigma Threshold</Label>
              <NumberSetting
                id={sigmaThresholdId}
                min={0.1}
                step="0.1"
                value={settings.sigma_threshold}
                onCommit={v => updateMut.mutate({ sigma_threshold: v })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={minExpectedCountId}>Min Expected Count</Label>
              <NumberSetting
                id={minExpectedCountId}
                min={0}
                value={settings.min_expected_count}
                onCommit={v => updateMut.mutate({ min_expected_count: v })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={recentSignalWindowId}>Open signal window (hours)</Label>
              <NumberSetting
                id={recentSignalWindowId}
                min={1}
                max={720}
                value={settings.recent_signal_window_hours}
                onCommit={v => updateMut.mutate({ recent_signal_window_hours: v })}
              />
              <p className="text-xs text-muted-foreground">
                How long an anomaly keeps counting as an open signal on the Anomalies page
                and in the sidebar badge. Between 1 and 720 hours (30 days). Alert delivery
                is unaffected.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={settlingMinutesId}>Ingestion settling (minutes)</Label>
              <NumberSetting
                id={settlingMinutesId}
                min={0}
                max={1440}
                value={settings.anomaly_ingestion_settling_minutes}
                onCommit={v => updateMut.mutate({ anomaly_ingestion_settling_minutes: v })}
              />
              <p className="text-xs text-muted-foreground">
                How long a warehouse keeps delivering rows for a bucket after that bucket
                closes. The newest buckets are still collected and charted, but raise no
                signal until the allowance has passed — so a half-delivered bucket is not
                read as a drop. Between 0 (score immediately) and 1440 minutes (24 hours);
                it is also the detection latency it buys.
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
    </div>
  )
}
