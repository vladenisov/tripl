/**
 * Turning a pasted block into a list of events to create.
 *
 * Kept pure and separate from the page because everything interesting here is a
 * rule, not a rendering: which columns a line has to supply, what the resulting
 * event is called, and whether that name is free. The page renders what this
 * returns.
 */
import { applyEventNameFormat } from './utils'

/** Why a parsed line cannot be created, or `ready` when it can. */
export type BulkRowStatus = 'ready' | 'incomplete' | 'duplicate' | 'exists'

export interface BulkRow {
  /** 1-based position in the pasted text, blank lines included, so the reader can find it. */
  line: number
  /** Values in naming-column order — or the single typed name when no rule applies. */
  values: string[]
  /** The event that would be created. */
  name: string
  /** The human label that followed the identity columns; empty when the line gave none. */
  title: string
  status: BulkRowStatus
  /** Naming columns this line left empty; only set when `status` is `incomplete`. */
  missing: string[]
}

/**
 * Split one line into the values its columns need, and the title after them.
 *
 * Whatever follows the last identity column is the title, kept whole with its
 * own delimiters — `weather_alert,show,widget,Weather alert widget shown` is
 * three columns and a label (tripl-kjhi.3). Past one column, a tab wins over a
 * comma — a paste out of a spreadsheet is tab-separated, and its cells may
 * themselves contain commas.
 *
 * A single identity column (a one-column format, or a free-text name) is only
 * ever split on a TAB: `{page}` names events after paths like
 * `/buoy/2758a8b1.../Tregde+A`, which carry commas, and a comma there would
 * tear the identity apart to make a title nobody asked for.
 */
function splitLine(line: string, columnCount: number): { values: string[]; title: string } {
  const identityCount = Math.max(columnCount, 1)
  const delimiter = line.includes('\t') ? '\t' : identityCount > 1 ? ',' : null
  if (delimiter === null) return { values: [line.trim()], title: '' }
  const parts = line.split(delimiter)
  return {
    values: parts.slice(0, identityCount).map(part => part.trim()),
    title: parts.slice(identityCount).join(delimiter).trim(),
  }
}

export interface ParseBulkDraftOptions {
  /** Columns the name format reads, in the order it reads them. Empty when unruled. */
  columns: string[]
  /** The governing `event_name_format`, or null when the user names events freely. */
  nameFormat: string | null
  /**
   * Identities already in the catalog — `source_name` where an event has one,
   * its `name` otherwise, which is what the next scan would adopt. Matching the
   * server's own rule (`_event_holding_scan_identity`) is the point: a name is
   * not free just because no event DISPLAYS it.
   */
  taken?: ReadonlySet<string>
}

export function parseBulkDraft(text: string, options: ParseBulkDraftOptions): BulkRow[] {
  const { columns, nameFormat, taken } = options
  const rows: BulkRow[] = []
  const seen = new Set<string>()

  const classify = (name: string): BulkRowStatus => {
    if (seen.has(name)) return 'duplicate'
    if (taken?.has(name)) return 'exists'
    return 'ready'
  }

  text.split('\n').forEach((rawLine, index) => {
    const line = index + 1
    if (rawLine.trim() === '') return

    const { values, title } = splitLine(rawLine, columns.length)

    if (nameFormat === null) {
      const name = values[0] ?? ''
      const status = classify(name)
      if (status === 'ready') seen.add(name)
      rows.push({ line, values, name, title, status, missing: [] })
      return
    }

    const valuesByColumn: Record<string, string> = {}
    columns.forEach((column, position) => {
      const value = values[position]
      if (value) valuesByColumn[column] = value
    })
    const { name, missing } = applyEventNameFormat(nameFormat, valuesByColumn)

    if (missing.length > 0) {
      rows.push({ line, values, name, title, status: 'incomplete', missing })
      return
    }
    const status = classify(name)
    if (status === 'ready') seen.add(name)
    rows.push({ line, values, name, title, status, missing: [] })
  })

  return rows
}

/**
 * Why this event type cannot be filled from a pasted block, or null when it can.
 *
 * Both refusals are narrow and checkable, and saying so beats accepting a paste
 * the server will reject item by item.
 */
export function bulkUnsupportedReason(options: {
  nameFormat: string | null
  namingColumns: string[]
  /** Field names the type marks required. */
  requiredFields: string[]
}): string | null {
  const { nameFormat, namingColumns, requiredFields } = options
  if (nameFormat !== null && nameFormat.includes('.')) {
    return (
      'This event type names its events from a value inside a JSON field, which a '
      + 'pasted list cannot fill. Add these events one at a time.'
    )
  }
  const unfillable = requiredFields.filter(field => !namingColumns.includes(field))
  if (unfillable.length > 0) {
    return (
      `Every event of this type needs ${unfillable.join(', ')}, which a pasted list `
      + 'does not carry. Add these events one at a time, or make the fields optional.'
    )
  }
  return null
}
