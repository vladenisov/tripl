import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ScanConfigPreview } from '@/types'
import { formatPreviewCell } from './scanUtils'

/**
 * Sample rows from the draft query. Mounted in the form's always-visible
 * essentials block, directly under the "Load preview" button.
 *
 * The JSON-value-path picker used to live here; it moved to
 * JsonValuePathsPicker so this panel is only ever about what the query returns.
 */
export function ScanPreviewPanel({ preview }: { preview: ScanConfigPreview }) {
  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium">Preview</div>
        <p className="text-xs text-muted-foreground">
          Column pickers use the sample rows. JSON paths are discovered on demand to keep the preview fast.
        </p>
      </div>

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
            {preview.rows.slice(0, 5).map((row, index) => (
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
    </div>
  )
}
