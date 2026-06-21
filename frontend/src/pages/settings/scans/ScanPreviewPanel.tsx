import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import type { ScanConfigPreview } from '@/types'
import { formatPreviewCell, jsonColumnsWithSelectedPaths } from './scanUtils'

export function ScanPreviewPanel({
  preview,
  selectedJsonValuePaths,
  onToggleJsonValuePath,
  onDiscoverJsonPaths,
  isDiscoveringJsonPaths,
  jsonPathsError,
  jsonPathsDiscovered,
}: {
  preview: ScanConfigPreview
  selectedJsonValuePaths: string[]
  onToggleJsonValuePath: (path: string) => void
  onDiscoverJsonPaths: () => void
  isDiscoveringJsonPaths: boolean
  jsonPathsError?: unknown
  jsonPathsDiscovered: boolean
}) {
  const jsonColumns = jsonColumnsWithSelectedPaths(preview, selectedJsonValuePaths)
  const hasJsonColumns = preview.json_columns.length > 0
  const hasAnyPaths = jsonColumns.some(column => column.paths.length > 0)

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

      {hasJsonColumns && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">JSON values to keep as-is</div>
              <p className="text-xs text-muted-foreground">
                Selected paths stay as real values in generated JSON. Unselected paths become variables.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDiscoverJsonPaths}
              disabled={isDiscoveringJsonPaths}
            >
              {isDiscoveringJsonPaths
                ? 'Discovering…'
                : jsonPathsDiscovered
                  ? 'Re-scan JSON keys'
                  : 'Discover JSON keys'}
            </Button>
          </div>

          {jsonPathsError != null && (
            <ErrorState compact title="JSON key discovery failed" error={jsonPathsError} />
          )}

          {hasAnyPaths ? (
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
                            aria-label={`Keep JSON path ${path.path} as value`}
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
          ) : (
            <div className="text-xs text-muted-foreground">
              {jsonPathsDiscovered
                ? 'No nested JSON keys found in the sampled rows.'
                : 'Discover JSON keys to choose which nested values to keep as-is.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
