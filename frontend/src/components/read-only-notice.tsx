import type { ReactNode } from 'react'

import { VIEWER_READ_ONLY_HINT } from '@/lib/permissions'

/**
 * The once-per-section line that explains why write controls are missing.
 *
 * Same box the alerting sections draw around `VIEWER_READ_ONLY_NOTICE`, so a
 * read-only surface looks the same wherever the reader meets one. Defaults to
 * the generic viewer copy; pass children for a narrower rule ("Only an owner
 * can …").
 */
export function ReadOnlyNotice({
  children = VIEWER_READ_ONLY_HINT,
  className = '',
}: {
  children?: ReactNode
  className?: string
}) {
  return (
    <p
      role="note"
      className={`rounded-md border border-dashed p-3 text-xs text-muted-foreground ${className}`}
    >
      {children}
    </p>
  )
}
