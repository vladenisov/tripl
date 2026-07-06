import type { IntervalCode, ScanConfigPreview, ScanJob } from '@/types'
import { formatRelativeTime } from '@/lib/datetime'
import type { ScanStatus } from './scanLayoutConstants'

// Derive a canonical scan status from its most recent job. The real ScanConfig
// has no status column, so the latest job's state drives the dot/label.
export interface ScanRunInfo {
  status: ScanStatus
  lastRunLabel: string
  lastJob: ScanJob | null
}

export function deriveScanRunInfo(jobs: ScanJob[]): ScanRunInfo {
  const lastJob = jobs[0] ?? null
  if (!lastJob) return { status: 'idle', lastRunLabel: 'never', lastJob: null }
  if (lastJob.status === 'running' || lastJob.status === 'pending') {
    return { status: 'running', lastRunLabel: 'running', lastJob }
  }
  const stamp = lastJob.completed_at ?? lastJob.started_at ?? lastJob.created_at
  const lastRunLabel = formatRelativeTime(stamp)
  if (lastJob.status === 'failed') return { status: 'failed', lastRunLabel, lastJob }
  return { status: 'ok', lastRunLabel, lastJob }
}

// Total scan rows from a job's result summary, falling back across the fields the
// backend may populate (query rows scanned vs. processed).
export function jobRowsScanned(job: ScanJob | null): number | null {
  if (!job?.result_summary) return null
  return job.result_summary.query_rows_scanned ?? job.result_summary.scan_rows_processed ?? null
}

export function jobDurationSeconds(job: ScanJob): number | null {
  if (!job.started_at || !job.completed_at) return null
  return (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000
}

// Number of consecutive most-recent runs that FAILED. `jobs` is newest-first.
// Active (pending/running) jobs at the head are skipped so an in-flight retry
// does not reset the count; the streak stops at the first settled non-failed run.
// Used to collapse a wall of identical failed rows into one "failed last N runs"
// indicator (tripl-7l83.4).
export function consecutiveFailedRuns(jobs: ScanJob[]): number {
  let streak = 0
  for (const job of jobs) {
    if (job.status === 'pending' || job.status === 'running') continue
    if (job.status === 'failed') {
      streak += 1
      continue
    }
    break
  }
  return streak
}


export function formatPreviewCell(value: unknown): string {
  if (value == null) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

export function splitFullJsonPath(fullPath: string): { column: string; path: string } | null {
  const separatorIndex = fullPath.indexOf('.')
  if (separatorIndex <= 0 || separatorIndex === fullPath.length - 1) return null
  return {
    column: fullPath.slice(0, separatorIndex),
    path: fullPath.slice(separatorIndex + 1),
  }
}

export function jsonColumnsWithSelectedPaths(
  preview: ScanConfigPreview,
  selectedJsonValuePaths: string[],
): ScanConfigPreview['json_columns'] {
  const byColumn = new Map<string, ScanConfigPreview['json_columns'][number]>()

  preview.json_columns.forEach(jsonColumn => {
    byColumn.set(jsonColumn.column, {
      column: jsonColumn.column,
      paths: jsonColumn.paths.map(path => ({ ...path, sample_values: [...path.sample_values] })),
    })
  })

  selectedJsonValuePaths.forEach(fullPath => {
    const parsed = splitFullJsonPath(fullPath)
    if (!parsed) return

    const jsonColumn = byColumn.get(parsed.column) ?? { column: parsed.column, paths: [] }
    if (!jsonColumn.paths.some(path => path.full_path === fullPath)) {
      jsonColumn.paths.push({ full_path: fullPath, path: parsed.path, sample_values: [] })
    }
    byColumn.set(parsed.column, jsonColumn)
  })

  return Array.from(byColumn.values()).map(jsonColumn => ({
    ...jsonColumn,
    paths: [...jsonColumn.paths].sort((a, b) => a.path.localeCompare(b.path)),
  }))
}

// Ordered finest → coarsest. A replay chunk must be >= the collection interval,
// so eligible chunk sizes are the interval itself and anything coarser.
export const INTERVAL_ORDER: IntervalCode[] = ['15m', '1h', '6h', '1d', '1w']
export const CHUNK_LABELS: Record<IntervalCode, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '6h': '6 hours',
  '1d': '1 day',
  '1w': '1 week',
}

export function eligibleChunkIntervals(interval: string): IntervalCode[] {
  const idx = INTERVAL_ORDER.indexOf(interval as IntervalCode)
  if (idx < 0) return []
  return INTERVAL_ORDER.slice(idx)
}

export function parseOptionalPositiveInt(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

export function isJsonPreviewType(typeName: string) {
  return typeName.toLowerCase().includes('json')
}

export const SELECT_CLASS = 'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm'
