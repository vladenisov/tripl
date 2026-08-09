import { useState } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import type { ScanConfigPreview, ScanDryRunResponse } from '@/types'
import { ScanDryRunSummary } from './ScanDryRunSummary'
import { formatPreviewCell } from './scanUtils'

/**
 * The preview panel: what this scan would create, with the sample rows kept
 * underneath as evidence.
 *
 * The order is the whole change (tripl-3y7z.6). This panel used to BE the five
 * raw warehouse rows, which answer "did my query run" and nothing else — while
 * quick-start.md promised it showed "exactly which events, fields, and values
 * tripl would create". The rows are not deleted; they are demoted to the
 * evidence they always were, behind a disclosure, with their caption intact.
 *
 * Mounted at the foot of the form's always-visible essentials block, after the
 * fields the answer is computed from. The JSON-value-path picker used to live here; it moved
 * to JsonValuePathsPicker so this panel is only ever about what the query
 * returns and what tripl would make of it.
 */
/**
 * What the panel says when the draft cannot be dry-run yet.
 *
 * The question is unanswerable, not failed: with no event type and no event
 * type column there is nothing to name events after, so no scan — dry or real —
 * can create anything. Saying that is the whole fix; the alternative was firing
 * the run anyway and reporting the worker's own precondition back as
 * `Scan failed: …` under a heading claiming a scan had failed.
 */
const NO_EVENT_TARGET_TEXT =
  'Nothing tells this scan how to name events yet, so there is nothing to work out. '
  + 'Pick an Event type, or the Event type column your event names are in.'

const NOT_CHECKED_YET_TEXT = 'The sample rows are loaded. Now tripl can work out what this scan would create.'

export function ScanPreviewPanel({
  preview,
  dryRun,
  dryRunStale,
  dryRunPending,
  dryRunError,
  eventTargetMissing,
  onRecheck,
}: {
  preview: ScanConfigPreview
  /** Null until the first dry run resolves — the rows still render without it. */
  dryRun: ScanDryRunResponse | null
  /** The draft has moved since `dryRun` was computed, so it no longer describes it. */
  dryRunStale: boolean
  dryRunPending: boolean
  dryRunError: unknown
  /**
   * The draft names neither an event type nor an event type column, so no dry
   * run was asked for — and any answer already on screen described a draft that
   * could name events, which this one cannot.
   */
  eventTargetMissing: boolean
  onRecheck: () => void
}) {
  const [rowsOpen, setRowsOpen] = useState(false)
  const rows = preview.rows.slice(0, 5)
  const showAnswer = Boolean(dryRun) && !eventTargetMissing
  const offerFirstCheck =
    !eventTargetMissing && !dryRun && !dryRunPending && !dryRunError

  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      {/* No heading here, deliberately. The panel used to open with a second
          "Preview" title (the Field above it is already labelled Preview) and a
          sentence explaining that JSON paths are discovered on demand "to keep
          the preview fast" — tripl's own latency engineering, restated plumbing,
          and a duplicated word, all above the answer the user came for. The
          answer leads: the first line of this panel is now either
          "What this scan would create" or the one sentence saying why there is
          no answer yet. Nothing was lost by dropping the JSON-on-demand
          sentence: JsonValuePathsPicker expresses the same fact as a button you
          press ("Discover JSON keys"), which is where it is actionable. */}
      {eventTargetMissing && (
        <p className="text-xs" style={{ color: 'var(--fg-subtle)' }}>{NO_EVENT_TARGET_TEXT}</p>
      )}
      {offerFirstCheck && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 flex-1 text-xs text-muted-foreground">{NOT_CHECKED_YET_TEXT}</p>
          <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
            Check
          </Button>
        </div>
      )}
      {!eventTargetMissing && dryRunPending && (
        <p className="text-xs text-muted-foreground">Working out what this scan would create…</p>
      )}
      {!eventTargetMissing && !dryRunPending && Boolean(dryRunError) && (
        <div className="space-y-2">
          <ErrorState compact title="Could not work out what this scan would create" error={dryRunError} />
          {/* The rows are already loaded, so the retry is this one job rather
              than the whole preview — and without it the panel is a dead end. */}
          <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
            Try again
          </Button>
        </div>
      )}
      {showAnswer && dryRun && (
        <div className="space-y-2">
          {/* A dry run describes one specific draft. Once the draft moves the
              answer is stale, and a stale "would create 3 events: A, B, C" is
              worse than no answer — so it says so and offers the redo. */}
          {dryRunStale && !dryRunPending && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="m-0 flex-1 text-[11.5px]" style={{ color: 'var(--warning)' }}>
                The form changed since this check ran, so it no longer describes this scan.
              </p>
              <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
                Check again
              </Button>
            </div>
          )}
          <ScanDryRunSummary dryRun={dryRun} />
        </div>
      )}

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setRowsOpen(open => !open)}
          aria-expanded={rowsOpen}
          className="text-[12px] font-medium text-muted-foreground hover:underline"
        >
          {rowsOpen ? 'Hide sample rows' : `Show sample rows (${rows.length})`}
        </button>
        {rowsOpen && (
          <div className="rounded-lg border bg-background overflow-auto">
            <Table>
              <caption className="sr-only">Query preview — sample rows</caption>
              <TableHeader>
                <TableRow>
                  {preview.columns.map(column => (
                    <TableHead key={column.name}>{column.name}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={index}>
                    {preview.columns.map(column => (
                      <TableCell key={column.name} className="max-w-[220px] truncate text-xs">
                        {formatPreviewCell(row[column.name])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
