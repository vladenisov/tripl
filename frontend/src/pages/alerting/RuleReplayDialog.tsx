import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, History } from 'lucide-react'

import { alertingApi } from '@/api/alerting'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
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
import type { AlertMessageFormat, AlertRule, AlertRuleSimulateResponse } from '@/types'
import { getErrorMessage } from '@/lib/utils'
import { formatDateTime } from '@/lib/datetime'
import { formatPercentDelta } from '@/lib/percentDelta'
import { formatCooldown } from './constants'

const DAYS_OPTIONS = [1, 3, 7, 14, 30] as const

/**
 * The preview caption used to pick its wording from
 * `firings[0]?.scope_type ? 'destination' : 'Slack/Telegram'` — a field that
 * says nothing whatsoever about how a message is rendered, so the line was a
 * coin flip dressed as information (tripl-oxkt.17). What the preview is actually
 * rendered with is the rule's own message format, so that is what it now names.
 */
const MESSAGE_FORMAT_LABEL: Record<AlertMessageFormat, string> = {
  plain: 'plain text',
  slack_mrkdwn: 'Slack mrkdwn',
  telegram_html: 'Telegram HTML',
  telegram_markdownv2: 'Telegram MarkdownV2',
}

/** Thresholds to try WITHOUT saving them to the rule. */
interface ReplayOverrides {
  cooldownMinutes?: number
  minPercentDelta?: number
  minExpectedCount?: number
  sigmaThreshold?: number
}

type ReplayResult = {
  saved: AlertRuleSimulateResponse
  override: AlertRuleSimulateResponse | null
}

/**
 * A blank box means "leave this one alone", which is a different instruction
 * from 0 — `Number('')` is 0, so parsing without this guard would silently
 * replay every empty field as the most permissive threshold there is.
 */
function parseOverride(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

function ThresholdRow({
  label,
  used,
  saved,
}: {
  label: string
  used: string
  saved: string
}) {
  const changed = used !== saved
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={changed ? 'text-xs font-medium text-foreground' : 'text-xs text-muted-foreground'}>
        {used}
        {changed && <span className="text-muted-foreground"> (saved {saved})</span>}
      </dd>
    </div>
  )
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
  const [cooldownText, setCooldownText] = useState<string>('')
  const [minPercentText, setMinPercentText] = useState<string>('')
  const [minExpectedText, setMinExpectedText] = useState<string>('')
  const [sigmaText, setSigmaText] = useState<string>('')
  const [result, setResult] = useState<ReplayResult | null>(null)
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Only a value that actually DIFFERS from the rule counts as an override:
  // typing the saved number back in would otherwise cost a second identical
  // request and label the result "Override" when nothing was overridden.
  const requestedOverrides: ReplayOverrides = {}
  const cooldown = parseOverride(cooldownText)
  if (cooldown !== null && cooldown !== rule.cooldown_minutes) {
    requestedOverrides.cooldownMinutes = cooldown
  }
  const minPercent = parseOverride(minPercentText)
  if (minPercent !== null && minPercent !== rule.min_percent_delta) {
    requestedOverrides.minPercentDelta = minPercent
  }
  const minExpected = parseOverride(minExpectedText)
  if (minExpected !== null && minExpected !== rule.min_expected_count) {
    requestedOverrides.minExpectedCount = minExpected
  }
  // Sigma has no rule-level column to compare against — the detector's own
  // default is the baseline — so anything typed here is a change by definition.
  const sigma = parseOverride(sigmaText)
  if (sigma !== null) {
    requestedOverrides.sigmaThreshold = sigma
  }
  const hasOverrides = Object.keys(requestedOverrides).length > 0

  const simulateMut = useMutation({
    mutationFn: async ({ n, overrides }: { n: number; overrides: ReplayOverrides | null }) => {
      // Two runs, always: `*_used`/`*_saved` name the thresholds a single run
      // applied, but only a second run over the SAME window says how many
      // firings the change would actually have removed.
      const savedPromise = alertingApi.simulateRule(slug, destinationId, rule.id, n)
      if (!overrides) {
        const saved = await savedPromise
        return { saved, override: null } satisfies ReplayResult
      }
      const [saved, overrideResp] = await Promise.all([
        savedPromise,
        alertingApi.simulateRule(slug, destinationId, rule.id, n, overrides),
      ])
      return { saved, override: overrideResp } satisfies ReplayResult
    },
    onSuccess: (data) => {
      setResult(data)
      // A finished replay lands the alerting chapter's simulate step — inert
      // outside the demo scenario (the reducer drops every other step).
      notifyStepCompleted('alerting/simulate')
    },
  })

  const handleOpenChange = (value: boolean) => {
    onOpenChange(value)
    if (!value) {
      setResult(null)
      simulateMut.reset()
      setCooldownText('')
      setMinPercentText('')
      setMinExpectedText('')
      setSigmaText('')
    }
  }

  const displayResult = result?.override ?? result?.saved ?? null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-4xl min-w-0 flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" />
            Replay rule “{rule.name}”
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                Window
              </div>
              <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
                <SelectTrigger aria-label="Replay window" className="h-8 w-32 text-xs">
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
            {/* Every threshold the simulation can vary, tried WITHOUT saving it:
                answering "would Min % 300 cut these incidents" used to mean
                writing 300 onto the rule that is live-routing to a real channel
                and waiting to find out (tripl-oxkt.17). */}
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                Cooldown (min)
              </div>
              <Input
                aria-label="Cooldown override in minutes"
                type="number"
                min={0}
                placeholder={`saved: ${rule.cooldown_minutes}`}
                value={cooldownText}
                onChange={(e) => setCooldownText(e.target.value)}
                className="h-8 w-32 text-xs"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                Min %
              </div>
              <Input
                aria-label="Minimum percent delta override"
                type="number"
                min={0}
                step="0.1"
                placeholder={`saved: ${rule.min_percent_delta}`}
                value={minPercentText}
                onChange={(e) => setMinPercentText(e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                Min expected
              </div>
              <Input
                aria-label="Minimum expected count override"
                type="number"
                min={0}
                step="0.1"
                placeholder={`saved: ${rule.min_expected_count}`}
                value={minExpectedText}
                onChange={(e) => setMinExpectedText(e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </div>
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground" aria-hidden="true">
                Sigma
              </div>
              <Input
                aria-label="Sigma threshold override"
                type="number"
                min={0}
                step="0.1"
                placeholder="detector default"
                value={sigmaText}
                onChange={(e) => setSigmaText(e.target.value)}
                className="h-8 w-28 text-xs"
              />
            </div>
            <Button
              size="sm"
              onClick={() =>
                simulateMut.mutate({
                  n: days,
                  overrides: hasOverrides ? requestedOverrides : null,
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
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              Replay failed: {getErrorMessage(simulateMut.error)}
            </div>
          )}

          {result && (
            <>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <FiringsCountBadge
                  label="Saved thresholds"
                  count={result.saved.firings.length}
                  noisy={result.saved.noisy}
                />
                {result.override && (
                  <>
                    <span className="text-muted-foreground">→</span>
                    <FiringsCountBadge
                      label="With your overrides"
                      count={result.override.firings.length}
                      noisy={result.override.noisy}
                    />
                  </>
                )}
              </div>

              {/* What the shown run actually applied, against what the rule
                  stores. Without both halves a preview run and the rule's real
                  behaviour are indistinguishable on screen. */}
              {displayResult && (
                <div className="space-y-1">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                    <ThresholdRow
                      label="Cooldown"
                      used={formatCooldown(displayResult.cooldown_minutes_used)}
                      saved={formatCooldown(displayResult.cooldown_minutes_saved)}
                    />
                    <ThresholdRow
                      label="Min %"
                      used={String(displayResult.min_percent_delta_used)}
                      saved={String(displayResult.min_percent_delta_saved)}
                    />
                    <ThresholdRow
                      label="Min expected"
                      used={String(displayResult.min_expected_count_used)}
                      saved={String(displayResult.min_expected_count_saved)}
                    />
                    <ThresholdRow
                      label="Sigma"
                      used={displayResult.sigma_threshold_used === null
                        ? 'detector default'
                        : String(displayResult.sigma_threshold_used)}
                      saved={displayResult.sigma_threshold_saved === null
                        ? 'detector default'
                        : String(displayResult.sigma_threshold_saved)}
                    />
                  </dl>
                  <p className="text-[11px] text-muted-foreground">
                    Nothing here is saved to the rule — it keeps routing on its stored thresholds.
                  </p>
                </div>
              )}

              {displayResult && displayResult.firings.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No firings in this window. Try widening the range or relaxing thresholds.
                </div>
              ) : (
                displayResult && (
                  // A focusable named scroll region lets keyboard users reach columns
                  // that sit beyond a narrow viewport.
                  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Intentional scroll target.
                  <div role="region" aria-label="Replay firings" tabIndex={0}
                    className="max-h-72 min-w-0 max-w-full overflow-x-auto overflow-y-auto rounded-md border"
                  >
                    <table className="w-full min-w-[720px] table-fixed text-left text-xs">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="w-40 px-3 py-2 font-medium">When</th>
                          <th className="w-64 px-3 py-2 font-medium">Scope</th>
                          <th className="w-20 px-3 py-2 font-medium">Dir</th>
                          <th className="w-20 px-3 py-2 text-right font-medium">Actual</th>
                          <th className="w-24 px-3 py-2 text-right font-medium">Expected</th>
                          <th className="w-16 px-3 py-2 text-right font-medium">Δ%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayResult.firings.map((firing) => (
                          <tr key={firing.anomaly_id} className="border-t">
                            <td className="whitespace-nowrap px-3 py-1.5 font-mono">{formatDateTime(firing.bucket)}</td>
                            <td className="truncate px-3 py-1.5" title={firing.scope_name}>
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
                              {formatPercentDelta(firing.percent_delta, firing.expected_count)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}

              {displayResult?.rendered_message && (
                <div className="min-w-0 space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Preview — the message this run would have sent, as{' '}
                    {MESSAGE_FORMAT_LABEL[rule.message_format]}
                  </div>
                  <pre className="max-h-48 min-w-0 max-w-full overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
                    {displayResult.rendered_message}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
