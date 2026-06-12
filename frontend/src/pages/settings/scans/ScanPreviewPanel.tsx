import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import type { ScanConfigPreview } from '@/types'
import { formatPreviewCell, jsonColumnsWithSelectedPaths } from './scanUtils'

export function ScanPreviewPanel({
  preview,
  selectedJsonValuePaths,
  onToggleJsonValuePath,
}: {
  preview: ScanConfigPreview
  selectedJsonValuePaths: string[]
  onToggleJsonValuePath: (path: string) => void
}) {
  const jsonColumns = jsonColumnsWithSelectedPaths(preview, selectedJsonValuePaths)

  return (
    <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
      <div className="space-y-1">
        <div className="text-sm font-medium">Preview</div>
        <p className="text-xs text-muted-foreground">
          Column pickers use the sample rows; JSON path options are discovered from the source query.
        </p>
      </div>

      <div className="rounded-lg border bg-background overflow-auto">
        <Table>
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

      {jsonColumns.some(column => column.paths.length > 0) && (
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">JSON values to keep as-is</div>
            <p className="text-xs text-muted-foreground">
              Selected paths stay as real values in generated JSON. Unselected paths become variables.
            </p>
          </div>
          <div className="space-y-3">
            {jsonColumns.map(jsonColumn => (
              <div key={jsonColumn.column} className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {jsonColumn.column}
                </div>
                {jsonColumn.paths.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No nested paths found in sample.</div>
                ) : (
                  <div className="grid gap-2">
                    {jsonColumn.paths.map(path => (
                      <label key={path.full_path} className="flex items-start gap-2 rounded-md border bg-background p-2 text-sm">
                        <Checkbox
                          checked={selectedJsonValuePaths.includes(path.full_path)}
                          onCheckedChange={() => onToggleJsonValuePath(path.full_path)}
                        />
                        <span className="space-y-1">
                          <span className="block font-mono text-xs">{path.path}</span>
                          {path.sample_values.length > 0 && (
                            <span className="block text-xs text-muted-foreground">
                              sample: {path.sample_values.join(', ')}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
