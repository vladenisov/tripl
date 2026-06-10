import { Fragment, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, GitMerge, Play, RotateCcw } from "lucide-react"
import { scansApi } from "@/api/scans"
import type { EventType, ScanConfig, ScanJob } from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getErrorMessage } from '@/lib/utils'

function toDatetimeLocalValue(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function createDefaultReplayWindow() {
  const to = new Date()
  to.setMinutes(0, 0, 0)
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  return {
    from: toDatetimeLocalValue(from),
    to: toDatetimeLocalValue(to),
  }
}

/* ─── Scan Detail (jobs) ─── */
export function ScanDetail({ slug, scanConfig, eventTypes, branchId }: { slug: string; scanConfig: ScanConfig; eventTypes: EventType[]; branchId: string | null }) {
  const qc = useQueryClient()
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayFrom, setReplayFrom] = useState('')
  const [replayTo, setReplayTo] = useState('')
  const [applyGroupsMessage, setApplyGroupsMessage] = useState('')

  const etName = eventTypes.find((et: EventType) => et.id === scanConfig.event_type_id)?.display_name
  const canReplayMetrics = Boolean(scanConfig.time_column && scanConfig.interval)

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['scanJobs', slug, scanConfig.id],
    queryFn: () => scansApi.listJobs(slug, scanConfig.id),
    refetchInterval: 5000,
  })

  const runMut = useMutation({
    mutationFn: () => scansApi.run(slug, scanConfig.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] }),
  })

  const applyGroupsMut = useMutation({
    mutationFn: () => scansApi.applyEventGroups(slug, scanConfig.id),
    onMutate: () => setApplyGroupsMessage(''),
    onSuccess: () => {
      setApplyGroupsMessage('Group apply job queued.')
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      qc.invalidateQueries({ queryKey: ['events', slug] })
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
    },
  })

  const replayMut = useMutation({
    mutationFn: () => {
      if (!replayFrom || !replayTo) throw new Error('Select a period to replay')
      const from = new Date(replayFrom)
      const to = new Date(replayTo)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new Error('Period dates are invalid')
      }
      if (from >= to) throw new Error('Start must be before end')
      return scansApi.replayMetrics(slug, scanConfig.id, {
        time_from: from.toISOString(),
        time_to: to.toISOString(),
      })
    },
    onSuccess: () => {
      setReplayOpen(false)
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
    },
  })

  const openReplayDialog = () => {
    const defaultWindow = createDefaultReplayWindow()
    setReplayFrom(defaultWindow.from)
    setReplayTo(defaultWindow.to)
    setReplayOpen(true)
    replayMut.reset()
  }

  const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
    pending: 'outline',
    running: 'secondary',
    completed: 'default',
    failed: 'destructive',
  }

  return (
    <div className="border-t p-4 space-y-4">
      <Dialog open={replayOpen} onOpenChange={setReplayOpen}>
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={e => {
              e.preventDefault()
              replayMut.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>Replay Metrics Period</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>From</Label>
                <Input
                  type="datetime-local"
                  value={replayFrom}
                  onChange={e => setReplayFrom(e.target.value)}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>To</Label>
                <Input
                  type="datetime-local"
                  value={replayTo}
                  onChange={e => setReplayTo(e.target.value)}
                  required
                />
              </div>
            </div>
            {replayMut.isError && <p className="text-sm text-destructive">{getErrorMessage(replayMut.error)}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setReplayOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={replayMut.isPending}>
                <RotateCcw className="mr-1 h-3 w-3" />
                {replayMut.isPending ? 'Starting…' : 'Replay Period'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Query info panel */}
      <div className="rounded-lg border bg-muted/30 overflow-hidden">
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center justify-between">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Base Query (subquery)</span>
          <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
            <span>Threshold: <strong className="text-foreground">{scanConfig.cardinality_threshold}</strong></span>
            {scanConfig.event_type_column && <span>Group by: <strong className="text-foreground">{scanConfig.event_type_column}</strong></span>}
            {scanConfig.time_column && <span>Time col: <strong className="text-foreground">{scanConfig.time_column}</strong></span>}
            {scanConfig.event_name_format && <span>Name fmt: <strong className="text-foreground">{scanConfig.event_name_format}</strong></span>}
            {scanConfig.json_value_paths.length > 0 && (
              <span>JSON keep: <strong className="text-foreground">{scanConfig.json_value_paths.length}</strong></span>
            )}
            {scanConfig.metric_breakdown_columns.length > 0 && (
              <span>
                Breakdowns:
                <strong className="text-foreground">
                  {' '}
                  {scanConfig.metric_breakdown_columns.join(', ')}
                  {scanConfig.metric_breakdown_values_limit ? ` · top ${scanConfig.metric_breakdown_values_limit}` : ' · unlimited'}
                </strong>
              </span>
            )}
            {scanConfig.distribution_drift_fields.length > 0 && (
              <span>
                Distribution:
                <strong className="text-foreground">
                  {' '}
                  {scanConfig.distribution_drift_fields.join(', ')}
                </strong>
              </span>
            )}
            {scanConfig.event_group_rules.length > 0 && (
              <span>
                Groups:
                <strong className="text-foreground">
                  {' '}
                  {scanConfig.event_group_rules.map(rule => rule.name).join(', ')}
                </strong>
              </span>
            )}
            {etName && <span>Event Type: <strong className="text-foreground">{etName}</strong></span>}
            {scanConfig.interval && <span>Interval: <strong className="text-foreground">{scanConfig.interval}</strong></span>}
            {scanConfig.replay_chunk_interval && <span>Replay chunk: <strong className="text-foreground">{scanConfig.replay_chunk_interval}</strong></span>}
            <span>
              Monitoring:
              <strong className="text-foreground">
                {' '}
                {scanConfig.time_column && scanConfig.interval ? 'shared project settings' : 'requires time column + interval'}
              </strong>
            </span>
          </div>
        </div>
        <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap overflow-x-auto">{scanConfig.base_query}</pre>
      </div>

      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold">Jobs</h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => applyGroupsMut.mutate()}
            disabled={scanConfig.event_group_rules.length === 0 || applyGroupsMut.isPending}
            title={
              scanConfig.event_group_rules.length > 0
                ? 'Apply saved group rules to existing events'
                : 'Add event group rules first'
            }
          >
            <GitMerge className="mr-1 h-3 w-3" />
            {applyGroupsMut.isPending ? 'Applying…' : 'Apply Groups'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={openReplayDialog}
            disabled={!canReplayMetrics || replayMut.isPending}
            title={canReplayMetrics ? 'Replay metrics for a past period' : 'Requires time column and interval'}
          >
            <RotateCcw className="mr-1 h-3 w-3" />
            Replay Period
          </Button>
          <Button size="sm" onClick={() => runMut.mutate()} disabled={runMut.isPending}>
            <Play className="mr-1 h-3 w-3" />
            {runMut.isPending ? 'Starting…' : 'Run Scan'}
          </Button>
        </div>
      </div>

      {runMut.isError && <p className="text-sm text-destructive">{getErrorMessage(runMut.error)}</p>}
      {applyGroupsMut.isError && <p className="text-sm text-destructive">{getErrorMessage(applyGroupsMut.error)}</p>}
      {applyGroupsMessage && <p className="text-sm text-muted-foreground">{applyGroupsMessage}</p>}

      {isLoading && <p className="text-sm text-muted-foreground">Loading jobs…</p>}

      {jobs.length === 0 && !isLoading && (
        <p className="text-sm text-muted-foreground">No jobs yet. Click "Run Scan" to start.</p>
      )}

      {jobs.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="w-8"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job: ScanJob) => {
                const duration = job.started_at && job.completed_at
                  ? `${((new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000).toFixed(1)}s`
                  : job.started_at && job.status === 'running' ? 'running…' : '—'
                return (
                  <Fragment key={job.id}>
                  <TableRow>
                    <TableCell>
                      <Badge variant={statusVariant[job.status] ?? 'outline'} className="text-xs">{job.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.started_at ? new Date(job.started_at).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{duration}</TableCell>
                    <TableCell className="text-xs">
                      {job.status === 'failed' && (
                        <span className="text-destructive">{job.error_message}</span>
                      )}
                      {job.result_summary && (
                        <div className="flex gap-2">
                          {job.result_summary.events_created != null && (
                            <Badge variant="outline" className="text-[10px] text-green-600">+{job.result_summary.events_created} events</Badge>
                          )}
                          {job.result_summary.variables_created != null && job.result_summary.variables_created > 0 && (
                            <Badge variant="outline" className="text-[10px] text-blue-600">+{job.result_summary.variables_created} vars</Badge>
                          )}
                          {job.result_summary.variable_values_touched != null && job.result_summary.variable_values_touched > 0 && (
                            <Badge variant="outline" className="text-[10px] text-indigo-600">+{job.result_summary.variable_values_touched} var values</Badge>
                          )}
                          {job.result_summary.events_skipped != null && job.result_summary.events_skipped > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.events_skipped} skipped</Badge>
                          )}
                          {job.result_summary.events_grouped != null && job.result_summary.events_grouped > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.events_grouped} grouped</Badge>
                          )}
                          {job.result_summary.events_merged != null && job.result_summary.events_merged > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.events_merged} merged</Badge>
                          )}
                          {job.result_summary.signals_added != null && job.result_summary.signals_added > 0 && (
                            <Badge variant="outline" className="text-[10px] text-destructive">+{job.result_summary.signals_added} signals</Badge>
                          )}
                          {job.result_summary.signals_removed != null && job.result_summary.signals_removed > 0 && (
                            <Badge variant="outline" className="text-[10px] text-green-700">-{job.result_summary.signals_removed} signals</Badge>
                          )}
                          {job.result_summary.metrics_deleted != null && job.result_summary.metrics_deleted > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.metrics_deleted} replaced</Badge>
                          )}
                          {job.result_summary.breakdown_event_metrics != null && job.result_summary.breakdown_event_metrics > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.breakdown_event_metrics} breakdowns</Badge>
                          )}
                          {job.result_summary.distribution_drifts != null && job.result_summary.distribution_drifts > 0 && (
                            <Badge variant="outline" className="text-[10px]">{job.result_summary.distribution_drifts} drift rows</Badge>
                          )}
                          {job.result_summary.contract_violations_detected != null && job.result_summary.contract_violations_detected > 0 && (
                            <Badge variant="outline" className="text-[10px] text-destructive">{job.result_summary.contract_violations_detected} contracts</Badge>
                          )}
                          {job.result_summary.alerts_queued != null && job.result_summary.alerts_queued > 0 && (
                            <Badge variant="outline" className="text-[10px] text-amber-600">+{job.result_summary.alerts_queued} alerts</Badge>
                          )}
                          {job.result_summary.columns_analyzed != null && (
                            <span className="text-muted-foreground text-[10px]">{job.result_summary.columns_analyzed} cols</span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {(job.result_summary || job.error_message) && (
                        <Button variant="ghost" size="icon" className="h-6 w-6"
                          onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}>
                          <ChevronDown className={`h-3 w-3 transition-transform ${expandedJobId === job.id ? 'rotate-180' : ''}`} />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {expandedJobId === job.id && (
                    <TableRow>
                      <TableCell colSpan={5} className="p-0">
                        <div className="p-4 space-y-3 bg-muted/30">
                          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Job Details</h4>
                          {job.error_message && (
                            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-xs text-destructive font-mono whitespace-pre-wrap">
                              {job.error_message}
                            </div>
                          )}
                          {job.result_summary && (
                            <div className="space-y-3">
                              {(job.result_summary.time_from || job.result_summary.time_to) && (
                                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                                  <span className="font-medium text-foreground">
                                    {job.result_summary.mode === 'metrics_replay' ? 'Replay period' : 'Collection period'}
                                  </span>
                                  {job.result_summary.time_from && job.result_summary.time_to && (
                                    <span> · {new Date(job.result_summary.time_from).toLocaleString()} - {new Date(job.result_summary.time_to).toLocaleString()}</span>
                                  )}
                                </div>
                              )}
                              {job.result_summary.catalog_sync_skipped && (
                                <div className="rounded-md border border-amber-300/60 bg-amber-50/80 p-3 text-xs text-amber-900">
                                  Replay skipped event/variable catalog generation, but can still enrich observed variable values for existing templates.
                                </div>
                              )}
                              <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3 xl:grid-cols-5">
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-green-600">{job.result_summary.events_created ?? 0}</div><div className="text-muted-foreground">Events created</div></Card>
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-blue-600">{job.result_summary.variables_created ?? 0}</div><div className="text-muted-foreground">Variables created</div></Card>
                              {job.result_summary.variable_values_touched != null && (
                                <Card className="p-3 text-center"><div className="text-lg font-bold text-indigo-600">{job.result_summary.variable_values_touched}</div><div className="text-muted-foreground">Variable values touched</div></Card>
                              )}
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{job.result_summary.events_skipped ?? 0}</div><div className="text-muted-foreground">Events skipped</div></Card>
                              {job.result_summary.events_grouped != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.events_grouped}</div>
                                  <div className="text-muted-foreground">Events grouped</div>
                                </Card>
                              )}
                              {job.result_summary.events_merged != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.events_merged}</div>
                                  <div className="text-muted-foreground">Events merged</div>
                                </Card>
                              )}
                              <Card className="p-3 text-center"><div className="text-lg font-bold text-primary">{job.result_summary.columns_analyzed ?? 0}</div><div className="text-muted-foreground">Columns analyzed</div></Card>
                              {job.result_summary.signals_added != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.signals_added}</div>
                                  <div className="text-muted-foreground">Signals added</div>
                                </Card>
                              )}
                              {job.result_summary.signals_removed != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-green-700">{job.result_summary.signals_removed}</div>
                                  <div className="text-muted-foreground">Signals removed</div>
                                </Card>
                              )}
                              {job.result_summary.metrics_deleted != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.metrics_deleted}</div>
                                  <div className="text-muted-foreground">Metrics replaced</div>
                                </Card>
                              )}
                              {job.result_summary.breakdown_event_metrics != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.breakdown_event_metrics}</div>
                                  <div className="text-muted-foreground">Event breakdowns</div>
                                </Card>
                              )}
                              {job.result_summary.breakdown_anomalies_detected != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.breakdown_anomalies_detected}</div>
                                  <div className="text-muted-foreground">Breakdown anomalies</div>
                                </Card>
                              )}
                              {job.result_summary.distribution_drifts != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-foreground">{job.result_summary.distribution_drifts}</div>
                                  <div className="text-muted-foreground">Distribution rows</div>
                                </Card>
                              )}
                              {job.result_summary.significant_distribution_drifts != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.significant_distribution_drifts}</div>
                                  <div className="text-muted-foreground">Distribution signals</div>
                                </Card>
                              )}
                              {job.result_summary.contract_violations_detected != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-destructive">{job.result_summary.contract_violations_detected}</div>
                                  <div className="text-muted-foreground">Contract violations</div>
                                </Card>
                              )}
                              {job.result_summary.alerts_queued != null && (
                                <Card className="p-3 text-center">
                                  <div className="text-lg font-bold text-amber-600">{job.result_summary.alerts_queued}</div>
                                  <div className="text-muted-foreground">Alerts queued</div>
                                </Card>
                              )}
                              </div>
                            </div>
                          )}
                          {job.result_summary?.details && job.result_summary.details.length > 0 && (
                            <div>
                              <h5 className="text-xs font-semibold text-muted-foreground mb-1">Log</h5>
                              <div className="rounded-lg border bg-background p-2 max-h-48 overflow-y-auto">
                                {job.result_summary.details.map((detail, i) => (
                                  <div key={i} className="text-xs font-mono text-muted-foreground py-0.5 border-b border-border/50 last:border-0">{detail}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
