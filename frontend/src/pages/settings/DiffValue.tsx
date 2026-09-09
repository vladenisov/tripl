/** The branch-diff value renderer, lifted out of BranchesTab.tsx.
 *
 * Same constraint as `branchDiffFanout.ts`: BranchesTab.tsx has to stay
 * component-only for react-refresh, so the helpers these components are built
 * from — `inlineRecord`, `isFlatRecord`, `uniformRecords` — cannot be exported
 * from there. They live in `diffValueFormat.ts` beside this file, where a unit
 * test can reach them directly instead of mounting the whole tab behind a
 * router and four mocked APIs.
 *
 * The other half of the reason is size: BranchesTab.tsx is far past this
 * repo's 800-line ceiling, and this block is the largest piece of it that
 * owes the tab nothing (tripl-h2sx.16).
 */

import { useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import {
  COLUMN_LABEL,
  JSON_CELL_MIN_LENGTH,
  inlineRecord,
  isFlatRecord,
  uniformRecords,
} from './diffValueFormat'

/**
 * A table cell whose value may itself be a JSON payload.
 *
 * `property` is the field that made the prose form unreadable in the first
 * place: a whole `{"from_profile": "${property.forecast_profile}", …}` object
 * spliced into the middle of the line. A table alone would just move the same
 * blow-out into one column, so a parseable object collapses to a one-line
 * preview with the pretty-printed form a click away. Template tokens survive
 * `JSON.parse` untouched — they sit inside string values.
 */
function ValueCell({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const text = value === null || value === '' ? '∅' : String(value)
  const parsed = useMemo(() => {
    const trimmed = text.trim()
    if (text.length < JSON_CELL_MIN_LENGTH) return null
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return null
    }
  }, [text])

  if (parsed === null) {
    return (
      <span className="mono wrap-anywhere text-[11.5px]" style={{ color: 'var(--fg)' }}>
        {text}
      </span>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1 text-left"
      >
        <ChevronRight
          className="size-3 shrink-0 transition-transform"
          style={{ color: 'var(--fg-faint)', transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden="true"
        />
        <span className="mono truncate text-[11.5px]" style={{ color: 'var(--fg)' }}>
          {text}
        </span>
      </button>
      {open ? (
        <pre
          className="mono max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px]"
          style={{ color: 'var(--fg)', background: 'color-mix(in oklab, var(--fg) 5%, transparent)' }}
        >
          {JSON.stringify(parsed, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

export function RecordTable({
  rows,
  labelledBy,
}: {
  rows: Record<string, unknown>[]
  labelledBy?: string
}) {
  // `is_authored` is not review signal — the backend filters a flip of it out of
  // change detection (_MEMBER_ATTRS_NOT_A_CHANGE), because it flips whenever a
  // person re-saves a scan-observed value unchanged. A column of it would take
  // width from the value, which is the cell that actually needs it, so it rides
  // along as a chip on the rows that came from a scan.
  const columns = Object.keys(rows[0]).filter((key) => key !== 'is_authored')
  const authoredKnown = 'is_authored' in rows[0]
  const chipColumn = columns.includes('value') ? 'value' : columns[columns.length - 1]
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((key) => (
            <TableHead key={key} className="h-7 px-2 text-[10px]">
              {COLUMN_LABEL[key] ?? key.replace(/_/g, ' ')}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody aria-labelledby={labelledBy}>
        {rows.map((row, idx) => (
          <TableRow key={idx}>
            {columns.map((key) => (
              <TableCell key={key} className="px-2 py-1 align-top">
                <div className="flex min-w-0 items-start gap-2">
                  <ValueCell value={row[key]} />
                  {authoredKnown && key === chipColumn && row.is_authored === false ? (
                    <Chip tone="neutral" size="xs" className="shrink-0">
                      from scan
                    </Chip>
                  ) : null}
                </div>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Renders a diff value the way a reviewer reads it: scalars plain, lists
 * comma-joined, flat records as inline `key: value` pairs, and nested records
 * one per line. Pretty-printed JSON is the last resort, not the default.
 * `tone` colours the before (danger) / after (success) sides of a diff.
 *
 * `wrap-anywhere` (overflow-wrap: anywhere) rather than `break-words`
 * (overflow-wrap: break-word): only the former reduces the element's
 * MIN-CONTENT width. `break-words` wraps once the box is already constrained,
 * but it still reports a long unbroken token as the minimum the box needs, so
 * inside an auto-minimum track it grows the column instead of wrapping — which
 * is how one long event description made the whole page scroll sideways. */
export function DiffValue({
  value,
  tone,
  table,
  labelledBy,
}: {
  value: unknown
  tone?: ChipTone
  /** Render a uniform array of records as a real table. Only the full-state
   * view asks for this; see the comment at its call site. */
  table?: boolean
  labelledBy?: string
}) {
  const color = tone ? `var(--${tone})` : 'var(--fg)'
  const isEmpty =
    value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
  if (isEmpty) {
    return (
      <span className="mono text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
        ∅
      </span>
    )
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return (
        <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
          {value.map((item) => String(item)).join(', ')}
        </span>
      )
    }
    if (table) {
      const rows = uniformRecords(value)
      if (rows) return <RecordTable rows={rows} labelledBy={labelledBy} />
    }
    if (value.every(isFlatRecord)) {
      return (
        <div className="flex flex-col gap-0.5">
          {value.map((item, idx) => (
            <span
              key={idx}
              className="mono wrap-anywhere text-[11.5px]"
              style={{ color }}
            >
              {inlineRecord(item)}
            </span>
          ))}
        </div>
      )
    }
  }
  if (isFlatRecord(value)) {
    return (
      <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
        {inlineRecord(value)}
      </span>
    )
  }
  if (typeof value === 'object') {
    return (
      <pre
        className="mono max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px]"
        style={{ color, background: 'color-mix(in oklab, var(--fg) 5%, transparent)' }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return (
    <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
      {String(value)}
    </span>
  )
}
