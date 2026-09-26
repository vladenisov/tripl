import { countOf } from '@/lib/plural'
import type { DataSource } from '@/types'

/**
 * The delete confirm's sentence: counted from the list's usage fields when the
 * server sent them (DA-40), named without numbers when it did not.
 */
export function dataSourceDeleteMessage(ds: DataSource): string {
  if (ds.scan_count === undefined) {
    return `Delete "${ds.name}"? All associated scans and their runs will be removed.`
  }
  if (ds.scan_count === 0) {
    return `Delete "${ds.name}"? No scan reads it, so nothing else is removed.`
  }
  return `Delete "${ds.name}"? ${countOf(ds.scan_count, 'scan', 'scans')} and ${countOf(ds.scan_run_count ?? 0, 'run', 'runs')} will be removed with it.`
}

/**
 * The card's usage line (DA-40): how many scans read this source, so the
 * delete's reach is visible before the confirm. Counts only — a scan can sit
 * in a project the reader does not work in, so the list carries no names.
 * Null when the server did not send the count.
 */
export function dataSourceUsageLabel(ds: DataSource): string | null {
  if (ds.scan_count === undefined) return null
  if (ds.scan_count === 0) return 'Not used by any scan'
  return `Used by ${countOf(ds.scan_count, 'scan', 'scans')}`
}

/**
 * A source that scans read must be deleted deliberately: the confirm arms only
 * once its name is typed (DA-40). A source nothing reads keeps the plain confirm.
 */
export function dataSourceDeleteRequireText(ds: DataSource): string | undefined {
  return (ds.scan_count ?? 0) > 0 ? ds.name : undefined
}
