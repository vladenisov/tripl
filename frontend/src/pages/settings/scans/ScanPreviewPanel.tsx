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
 * Mounted in the form's always-visible essentials block, directly under the
 * "Load preview" button. The JSON-value-path picker used to live here; it moved
 * to JsonValuePathsPicker so this panel is only ever about what the query
 * returns and what tripl would make of it.
 */
export function ScanPreviewPanel({
  preview,
  dryRun,
  dryRunStale,
  dryRunPending,
  dryRunError,
  onRecheck,
}: {
  preview: ScanConfigPreview
  /** Null until the first dry run resolves — the rows still render without it. */
  dryRun: ScanDryRunResponse | null
  /** The draft has moved since `dryRun` was computed, so it no longer describes it. */
  dryRunStale: boolean
  dryRunPending: boolean
  dryRunError: unknown
  onRecheck: () => void
}) {
  const [rowsOpen, setRowsOpen] = useState(false)
  const rows = preview.rows.slice(0, 5)

  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium">Preview</div>
        <p className="text-xs text-muted-foreground">
          Column pickers use the sample rows. JSON paths are discovered on demand to keep the preview fast.
        </p>
      </div>

      {dryRunPending && (
        <p className="text-xs text-muted-foreground">Working out what this scan would create…</p>
      )}
      {!dryRunPending && Boolean(dryRunError) && (
        <ErrorState compact title="Could not work out what this scan would create" error={dryRunError} />
      )}
      {dryRun && (
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
