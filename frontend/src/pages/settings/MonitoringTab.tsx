import { useId, type ChangeEvent } from "react"
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
 * Commit a numeric settings edit, ignoring a transient empty field.
 *
 * These inputs save on every keystroke, and the field is briefly empty whenever
 * someone selects-all and retypes. `Number('')` is `0`, which is a *valid*
 * value for `min_expected_count` and `anomaly_ingestion_settling_minutes` — so
 * a blank frame would silently persist "0" (for settling: score immediately,
 * i.e. the very behaviour the allowance exists to prevent) instead of being
 * rejected the way an out-of-range `0` is on the min-1 fields. Empty and
 * non-numeric input is dropped; the input keeps showing the last saved value.
 */
function onNumberChange(commit: (value: number) => void) {
  return (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim()
    if (raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    commit(value)
  }
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
              <Input
                id={baselineWindowId}
                type="number"
                min={1}
                value={settings.baseline_window_buckets}
                onChange={onNumberChange(v => updateMut.mutate({ baseline_window_buckets: v }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={minHistoryId}>Min History</Label>
              <Input
                id={minHistoryId}
                type="number"
                min={1}
                value={settings.min_history_buckets}
                onChange={onNumberChange(v => updateMut.mutate({ min_history_buckets: v }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={sigmaThresholdId}>Sigma Threshold</Label>
              <Input
                id={sigmaThresholdId}
                type="number"
                min={0.1}
                step="0.1"
                value={settings.sigma_threshold}
                onChange={onNumberChange(v => updateMut.mutate({ sigma_threshold: v }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={minExpectedCountId}>Min Expected Count</Label>
              <Input
                id={minExpectedCountId}
                type="number"
                min={0}
                value={settings.min_expected_count}
                onChange={onNumberChange(v => updateMut.mutate({ min_expected_count: v }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={recentSignalWindowId}>Open signal window (hours)</Label>
              <Input
                id={recentSignalWindowId}
                type="number"
                min={1}
                max={720}
                value={settings.recent_signal_window_hours}
                onChange={onNumberChange(v =>
                  updateMut.mutate({ recent_signal_window_hours: v })
                )}
              />
              <p className="text-xs text-muted-foreground">
                How long an anomaly keeps counting as an open signal on the Anomalies page
                and in the sidebar badge. Between 1 and 720 hours (30 days). Alert delivery
                is unaffected.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={settlingMinutesId}>Ingestion settling (minutes)</Label>
              <Input
                id={settlingMinutesId}
                type="number"
                min={0}
                max={1440}
                value={settings.anomaly_ingestion_settling_minutes}
                onChange={onNumberChange(v =>
                  updateMut.mutate({ anomaly_ingestion_settling_minutes: v })
                )}
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
