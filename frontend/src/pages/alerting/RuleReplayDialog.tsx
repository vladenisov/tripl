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
  const [result, setResult] = useState<AlertRuleSimulateResponse | null>(null)

  const simulateMut = useMutation({
    mutationFn: (n: number) => alertingApi.simulateRule(slug, destinationId, rule.id, n),
    onSuccess: (data) => setResult(data),
  })

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value)
    if (!value) {
      setResult(null)
      simulateMut.reset()
    }
  }

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
          <div className="flex items-end gap-3">
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
            <Button
              size="sm"
              onClick={() => simulateMut.mutate(days)}
              disabled={simulateMut.isPending}
            >
              {simulateMut.isPending ? 'Replaying…' : 'Replay'}
            </Button>
            {result && (
              <div className="ml-auto text-right text-xs text-muted-foreground">
                <div>
                  Considered <span className="font-medium text-foreground">{result.anomalies_considered}</span> anomalies
                </div>
                <div>
                  Matched <span className="font-medium text-foreground">{result.matched_before_cooldown}</span> before cooldown
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
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <span>
                  Would fire{' '}
                  <span className="font-semibold">{result.firings.length}</span>{' '}
                  {result.firings.length === 1 ? 'time' : 'times'} in {result.days}d
                </span>
                {result.noisy && (
                  <Badge variant="destructive" className="gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" />
                    Noisy rule
                  </Badge>
                )}
              </div>

              {result.firings.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No firings in this window. Try widening the range or relaxing thresholds.
                </div>
              ) : (
                <div className="max-h-96 overflow-auto rounded-md border">
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
                      {result.firings.map((firing) => (
                        <tr key={firing.anomaly_id} className="border-t">
                          <td className="px-3 py-1.5 font-mono">{formatBucket(firing.bucket)}</td>
                          <td className="px-3 py-1.5 truncate" title={firing.scope_name}>
                            <span className="text-muted-foreground">{firing.scope_type}</span>{' '}
                            {firing.scope_name}
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
