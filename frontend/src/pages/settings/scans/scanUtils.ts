import type { IntervalCode, ScanConfigPreview } from '@/types'

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
