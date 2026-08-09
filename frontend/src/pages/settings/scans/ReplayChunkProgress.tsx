import type { ScanJobResultSummary } from '@/types'
import { formatDateTime } from '@/lib/datetime'

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getReplayProgress(summary: ScanJobResultSummary | null) {
  if (!summary || summary.mode !== 'metrics_replay' || !summary.replay_chunks_total) {
    return null
  }
  const total = Math.max(summary.replay_chunks_total, 0)
  if (total === 0) return null
  const completed = clamp(summary.replay_chunks_completed ?? 0, 0, total)
  const percent = clamp(summary.replay_progress_percent ?? (completed / total) * 100, 0, 100)
  const current = summary.replay_current_chunk_index
    ? clamp(summary.replay_current_chunk_index, 1, total)
    : null
  return {
    completed,
    total,
    current,
    percent,
    phase: summary.replay_progress_phase,
    currentFrom: summary.replay_current_chunk_from,
    currentTo: summary.replay_current_chunk_to,
  }
}

/**
 * Chunk progress for a metrics replay. Lives in its own module because both the
 * run table row (compact) and the expanded run report render it, and those two
 * now sit in different files — importing it back out of `ScanDetail` would make
 * the pair circular.
 */
export function ReplayChunkProgress({
  summary,
  compact = false,
}: {
  summary: ScanJobResultSummary
  compact?: boolean
}) {
  const progress = getReplayProgress(summary)
  if (!progress) return null

  const chunkLabel = `${progress.completed}/${progress.total} chunks`
  const phaseLabel = progress.phase === 'collecting' && progress.current
    ? `processing ${progress.current}/${progress.total}`
    : progress.phase

  return (
    <div className={compact ? 'w-44 max-w-full space-y-1' : 'space-y-2'}>
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">Replay chunks</span>
        <span>{chunkLabel}</span>
      </div>
      <div
        aria-label="Replay chunks"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(progress.percent)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {phaseLabel && <span>{phaseLabel}</span>}
          {progress.currentFrom && progress.currentTo && (
            <span>
              {formatDateTime(progress.currentFrom)} - {formatDateTime(progress.currentTo)}
            </span>
          )}
        </div>
      )}
      {compact && phaseLabel && <div className="text-[10px] text-muted-foreground">{phaseLabel}</div>}
    </div>
  )
}
