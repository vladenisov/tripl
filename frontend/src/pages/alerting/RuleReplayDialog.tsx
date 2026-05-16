import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, History } from 'lucide-react'

import { alertingApi } from '@/api/alerting'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import type { AlertRule, AlertRuleSimulateResponse } from '@/types'

const DAYS_OPTIONS = [1, 3, 7, 14, 30] as const

type ReplayResult = {
  saved: AlertRuleSimulateResponse
  override: AlertRuleSimulateResponse | null
}

function formatBucket(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`
}

function FiringsCountBadge({
  label,
  count,
  noisy,
}: {
  label: string
  count: number
  noisy: boolean
}) {
  return (
    <div className="flex flex-col items-start rounded-md border bg-muted/30 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <span className="text-base font-semibold tnum">{count}</span>
        <span className="text-xs text-muted-foreground">{count === 1 ? 'firing' : 'firings'}</span>
        {noisy && (
          <Badge variant="destructive" className="gap-1 text-[10px]">
            <AlertTriangle className="h-3 w-3" />
            Noisy
          </Badge>
        )}
      </div>
    </div>
  )
}

export function RuleReplayDialog({
  open,
  onOpenChange,
  slug,
  destinationId,
  rule,
}: {
  open: boolean
  onOpenChange: (value: boolean) => void
  slug: string
  destinationId: string
  rule: AlertRule
}) {
  const [days, setDays] = useState<number>(7)
  const [overrideText, setOverrideText] = useState<string>('')
  const [result, setResult] = useState<ReplayResult | null>(null)

  const overrideValue =
    overrideText.trim() === '' ? null : Math.max(0, Number(overrideText.trim()))
  const overrideIsValid = overrideValue === null || Number.isFinite(overrideValue)
  const overrideDiffersFromSaved =
    overrideValue !== null && overrideValue !== rule.cooldown_minutes

  const simulateMut = useMutation({
    mutationFn: async ({ n, override }: { n: number; override: number | null }) => {
      const savedPromise = alertingApi.simulateRule(slug, destinationId, rule.id, n)
      if (override === null || override === rule.cooldown_minutes) {
        const saved = await savedPromise
        return { saved, override: null } satisfies ReplayResult
      }
      const [saved, overrideResp] = await Promise.all([
        savedPromise,
        alertingApi.simulateRule(slug, destinationId, rule.id, n, override),
      ])
      return { saved, override: overrideResp } satisfies ReplayResult
    },
    onSuccess: (data) => setResult(data),
  })

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value)
    if (!value) {
      setResult(null)
      simulateMut.reset()
      setOverrideText('')
    }
  }

  const displayResult = result?.override ?? result?.saved ?? null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Replay rule “{rule.name}”
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Window
              </div>
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      Last {option}d
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Cooldown override (min)
              </div>
              <Input
                type="number"
                min={0}
                placeholder={`saved: ${rule.cooldown_minutes}`}
                value={overrideText}
                onChange={(e) => setOverrideText(e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <Button
              size="sm"
              onClick={() =>
                simulateMut.mutate({
                  n: days,
                  override: overrideIsValid ? overrideValue : null,
                })
              }
              disabled={simulateMut.isPending}
            >
              {simulateMut.isPending ? 'Replaying…' : 'Replay'}
            </Button>
            {displayResult && (
              <div className="ml-auto text-right text-xs text-muted-foreground">
                <div>
                  Considered{' '}
                  <span className="font-medium text-foreground">
                    {displayResult.anomalies_considered}
                  </span>{' '}
                  anomalies
                </div>
                <div>
                  Matched{' '}
                  <span className="font-medium text-foreground">
                    {displayResult.matched_before_cooldown}
                  </span>{' '}
                  before cooldown
                </div>
              </div>
            )}
          </div>

          {simulateMut.isError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              Replay failed: {(simulateMut.error as Error).message}
            </div>
          )}

          {result && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <FiringsCountBadge
                  label={`Saved (${result.saved.cooldown_minutes_saved} min)`}
                  count={result.saved.firings.length}
                  noisy={result.saved.noisy}
                />
                {result.override && overrideDiffersFromSaved && (
                  <>
                    <span className="text-muted-foreground">→</span>
                    <FiringsCountBadge
                      label={`Override (${result.override.cooldown_minutes_used} min)`}
                      count={result.override.firings.length}
                      noisy={result.override.noisy}
                    />
                  </>
                )}
              </div>

              {displayResult && displayResult.firings.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No firings in this window. Try widening the range or relaxing thresholds.
                </div>
              ) : (
                displayResult && (
                  <div className="max-h-72 overflow-auto rounded-md border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">When</th>
                          <th className="px-3 py-2 font-medium">Scope</th>
                          <th className="px-3 py-2 font-medium">Dir</th>
                          <th className="px-3 py-2 text-right font-medium">Actual</th>
                          <th className="px-3 py-2 text-right font-medium">Expected</th>
                          <th className="px-3 py-2 text-right font-medium">Δ%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayResult.firings.map((firing) => (
                          <tr key={firing.anomaly_id} className="border-t">
                            <td className="px-3 py-1.5 font-mono">{formatBucket(firing.bucket)}</td>
                            <td className="px-3 py-1.5 truncate" title={firing.scope_name}>
                              <span className="text-muted-foreground">{firing.scope_type}</span>{' '}
                              {firing.scope_name}
                              {firing.drift_field && (
                                <div className="truncate text-[11px] text-muted-foreground">
                                  {firing.drift_type}: {firing.drift_field}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-1.5">
                              <Badge
                                variant={firing.direction === 'spike' ? 'default' : 'secondary'}
                                className="text-[10px]"
                              >
                                {firing.direction}
                              </Badge>
                            </td>
                            <td className="px-3 py-1.5 text-right tnum">{firing.actual_count}</td>
                            <td className="px-3 py-1.5 text-right tnum text-muted-foreground">
                              {Math.round(firing.expected_count)}
                            </td>
                            <td className="px-3 py-1.5 text-right tnum">
                              {formatPercent(firing.percent_delta)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {displayResult?.rendered_message && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Preview (as it would render to {result.saved.firings[0]?.scope_type ? 'destination' : 'Slack/Telegram'})
                  </div>
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px]">
                    {displayResult.rendered_message}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
